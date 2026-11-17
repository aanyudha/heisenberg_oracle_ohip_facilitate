import type { FastifyInstance } from "fastify";
import { distributeRooms } from "@hospitality/contracts";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type {
  Worksheet,
  WorksheetScope,
  WorksheetRoom,
} from "@hospitality/contracts";
import { sql, type Database } from "./db.js";
import {
  resolveWorksheetCoverage,
  worksheetFloorRows,
  type SupervisorCoverage,
} from "@hospitality/contracts";
import type { Principal } from "./realtime.js";
import { staffStatusRows, staffStatus } from "./housekeeping-eligibility.js";
import {
  housekeepingFeed,
  roomConnection,
  housekeepingBinding,
  type RoomFeed,
} from "./housekeeping-feed.js";

type Row = Record<string, any>;
type Tx = { execute: Database["orm"]["execute"] };
type Access = { staff: Row[]; self: Row | undefined; manager: boolean };
type Helpers = {
  access: (tx: Tx, u: Principal, p: string) => Promise<Access>;
  locked: <T>(
    u: Principal,
    p: string,
    fn: (tx: Tx) => Promise<T>,
  ) => Promise<T>;
  changed: (
    tx: Tx,
    u: Principal,
    p: string,
    action: string,
    target: string,
    assignmentScope?: { date: string; shiftId: string },
  ) => Promise<void>;
};
const id = z.string().trim().min(1).max(100),
  scopeSchema = z
    .object({ propertyId: id, date: z.iso.date(), shiftId: id })
    .strict();
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
const where = (u: Principal, s: WorksheetScope) =>
  sql`tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND business_date=${s.date} AND shift_id=${s.shiftId}`;
type Plan = {
  supervisors: Row[];
  attendants: Row[];
  rooms: Row[];
  schedules?: { user_id: string; available: boolean | null }[];
};
const coverageRows = (rows: Row[]): SupervisorCoverage[] =>
  rows.map((r) => ({
    supervisorId: r.supervisor_id,
    floors: r.floors || [],
    rooms: r.rooms || [],
    coverage: r.coverage || [],
  }));
const cloneSupervisors = (rows: Row[]): Row[] =>
  rows.map((r) => ({
    ...r,
    floors: [...(r.floors || [])],
    rooms: [...(r.rooms || [])],
    coverage: [...(r.coverage || [])],
  }));
async function loadPlan(
  tx: Tx,
  u: Principal,
  s: WorksheetScope,
): Promise<Plan> {
  const supervisors = (
    await tx.execute(
      sql`SELECT * FROM housekeeping_supervisor_assignments WHERE ${where(u, s)} ORDER BY supervisor_id`,
    )
  ).rows;
  const attendants = (
    await tx.execute(
      sql`SELECT * FROM housekeeping_attendant_assignments WHERE ${where(u, s)} AND worksheet_active ORDER BY attendant_id`,
    )
  ).rows;
  const rooms = (
    await tx.execute(
      sql`SELECT * FROM housekeeping_room_assignments WHERE ${where(u, s)} AND active ORDER BY room_id`,
    )
  ).rows;
  return { supervisors, attendants, rooms };
}
async function revision(tx: Tx, u: Principal, p: string) {
  return String(
    (
      await tx.execute(
        sql`SELECT coalesce(max(seq),0)::text AS revision FROM change_events WHERE tenant_id=${u.tenantId} AND property_id=${p} AND topic='housekeeping'`,
      )
    ).rows[0].revision,
  );
}
export function registerHousekeepingWorksheet(
  app: FastifyInstance,
  db: Database,
  h: Helpers,
  transport?: typeof fetch,
) {
  const feed = housekeepingFeed(db, transport);
  async function assertFeed(
    tx: Tx,
    u: Principal,
    s: WorksheetScope,
    source: RoomFeed,
  ) {
    const c = await roomConnection(
      { ...db, query: async (q) => (await tx.execute(q)).rows } as Database,
      u.tenantId,
      s.propertyId,
    );
    if (source.source === "DEMO" && c?.mode !== "demo")
      throw fail(409, "Room source changed. Refresh the worksheet.");
    if (source.source === "OHIP" && source.available) {
      if (
        !c ||
        c.mode !== "real" ||
        !source.binding ||
        housekeepingBinding(c) !== source.binding ||
        c.validation_status !== "validated" ||
        c.paused ||
        c.property_paused ||
        c.archived_at
      )
        throw fail(
          409,
          "OPERA room authorization changed. Refresh the worksheet.",
        );
      const snapshot = (
        await tx.execute(
          sql`SELECT binding,synced_at FROM housekeeping_room_feeds WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND business_date=${s.date} AND status='synced'`,
        )
      ).rows[0] as Row | undefined;
      if (
        !snapshot ||
        snapshot.binding !== source.binding ||
        new Date(snapshot.synced_at).toISOString() !== source.syncedAt
      )
        throw fail(
          409,
          "Room snapshot changed during this request. Refresh the worksheet.",
        );
    }
  }
  async function assertPrincipal(tx: Tx, u: Principal, p: string) {
    if (
      !(
        await tx.execute(
          sql`SELECT 1 FROM sessions s JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id JOIN property_grants g ON g.tenant_id=s.tenant_id AND g.user_id=s.user_id WHERE s.token_hash=${u.tokenHash} AND s.tenant_id=${u.tenantId} AND s.user_id=${u.id} AND s.expires_at>now() AND m.role=${u.role} AND g.property_id=${p} AND NOT EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=s.tenant_id AND (a.kind='tenants' OR (a.kind='users' AND a.target=s.user_id) OR (a.kind='properties' AND a.target=g.property_id)))`,
        )
      ).rows.length
    )
      throw fail(403, "Worksheet access revoked");
  }
  async function enrich(
    tx: Tx,
    u: Principal,
    s: WorksheetScope,
    source: RoomFeed,
  ): Promise<WorksheetRoom[]> {
    const directory = (
      await tx.execute(
        sql`SELECT * FROM housekeeping_room_directory WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId}`,
      )
    ).rows as Row[];
    const reservations = (
      await tx.execute(
        sql`SELECT room,arrival::text,departure::text,status,vip FROM reservations WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND status NOT IN ('Cancelled','NoShow') AND (${source.source === "DEMO"} OR source!='DEMO')`,
      )
    ).rows as Row[];
    return source.rooms.map((room) => {
      const d = directory.find((d) => d.room_id === room.id),
        stays = reservations.filter((r) => r.room === room.id);
      const departure =
          room.departure || stays.some((r) => r.departure === s.date),
        arrival = room.arrival || stays.some((r) => r.arrival === s.date);
      const stayover =
        !departure &&
        (room.stayover ||
          stays.some(
            (r) =>
              r.arrival <= s.date &&
              r.departure > s.date &&
              ["InHouse", "DueOut"].includes(r.status),
          ));
      const vip =
        room.vip ||
        stays.some(
          (r) => r.vip && r.arrival <= s.date && r.departure >= s.date,
        );
      const configured = d?.credits_configured;
      const credits =
        room.creditSource === "OHIP"
          ? room.credits
          : configured
            ? Number(
                d[
                  departure
                    ? "departure_credits"
                    : stayover
                      ? "stayover_credits"
                      : "other_credits"
                ],
              )
            : null;
      const override =
        !room.floor && d?.location_source === "local_validated" && d.floor;
      return {
        ...room,
        departure,
        arrival,
        stayover,
        vip,
        priority: room.priority || vip || departure,
        credits,
        creditSource:
          room.creditSource === "OHIP"
            ? "OHIP"
            : configured
              ? "local"
              : "not_configured",
        floor: override ? d.floor : room.floor,
        floorSource: override ? "local_validated" : room.floorSource,
        section: override ? d.section : room.section,
      };
    });
  }
  async function currentFeed(u: Principal, s: WorksheetScope) {
    // Permission is checked before any outbound request and again when data is read/written.
    await h.access(db.orm, u, s.propertyId);
    await assertPrincipal(db.orm, u, s.propertyId);
    return feed.read(u.tenantId, s.propertyId, s.date);
  }
  async function getWorksheet(
    u: Principal,
    s: WorksheetScope,
    source: RoomFeed,
  ): Promise<Worksheet> {
    return db.orm.transaction(
      async (tx) => {
        await assertPrincipal(tx, u, s.propertyId);
        await assertFeed(tx, u, s, source);
        const a = await h.access(tx, u, s.propertyId);
        const property = (
          await tx.execute(
            sql`SELECT id,name FROM properties WHERE tenant_id=${u.tenantId} AND id=${s.propertyId}`,
          )
        ).rows[0] as { id: string; name: string };
        const shift = (
          await tx.execute(
            sql`SELECT id,name FROM housekeeping_shifts WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND id=${s.shiftId} AND active`,
          )
        ).rows[0] as { id: string; name: string } | undefined;
        if (!shift) throw fail(404, "Shift not found");
        const plan = await loadPlan(tx, u, s);
        const schedules = (
          await tx.execute(
            sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE ${where(u, s)}`,
          )
        ).rows as Row[];
        const team: Record<string, string> = Object.fromEntries(
          plan.attendants.map((r) => [
            String(r.attendant_id),
            String(r.supervisor_id),
          ]),
        );
        const ownAttendants = a.manager
          ? a.staff.filter((r) => r.job_role === "attendant")
          : a.self?.job_role === "supervisor"
            ? a.staff.filter(
                (r) =>
                  r.job_role === "attendant" &&
                  (team[r.user_id] === u.id || !Object.hasOwn(team, r.user_id)),
              )
            : a.staff.filter(
                (r) => r.user_id === u.id && r.job_role === "attendant",
              );
        // Keep missing/inactive staff visible to managers so existing rooms can be recovered.
        const visibleAttendantIds = new Set([
          ...ownAttendants.map((r) => r.user_id),
          ...plan.attendants
            .filter(
              (r) =>
                a.manager ||
                (a.self?.job_role === "supervisor"
                  ? r.supervisor_id === u.id
                  : r.attendant_id === u.id),
            )
            .map((r) => r.attendant_id),
        ]);
        const visibleSupervisorIds = new Set(
          a.manager
            ? a.staff
                .filter((r) => r.job_role === "supervisor")
                .map((r) => r.user_id)
            : a.self?.job_role === "supervisor"
              ? [u.id]
              : team[u.id]
                ? [team[u.id]]
                : [],
        );
        if (a.manager)
          for (const r of plan.supervisors)
            visibleSupervisorIds.add(r.supervisor_id);
        const statusRows = await staffStatusRows(tx, u.tenantId, s, [
          ...visibleAttendantIds,
          ...visibleSupervisorIds,
        ]);
        const staff = (ids: Set<string>, role: string) =>
          [...ids]
            .map((uid) => staffStatus(uid, role, statusRows.get(uid)))
            .sort(
              (a, b) =>
                Number(b.available) - Number(a.available) ||
                a.name.localeCompare(b.name, "id"),
            );
        const attendants = staff(visibleAttendantIds, "attendant"),
          supervisors = staff(visibleSupervisorIds, "supervisor");
        for (const attendant of attendants) {
          const supervisor = supervisors.find(
            (s) => s.id === team[attendant.id],
          );
          attendant.assignmentBlockReason =
            attendant.available &&
            team[attendant.id] &&
            (!supervisor?.active || !supervisor.available)
              ? "supervisor_unavailable"
              : attendant.available && !team[attendant.id] && a.manager
                ? "supervisor_required"
                : null;
        }
        const assignments = Object.fromEntries(
          plan.rooms
            .filter((r) => visibleAttendantIds.has(r.attendant_id))
            .map((r) => [r.room_id, r.attendant_id]),
        );
        const localProgress = Object.fromEntries(
          plan.rooms
            .filter((r) => visibleAttendantIds.has(r.attendant_id))
            .map((r) => [r.room_id, r.local_status]),
        );
        const allRooms = await enrich(tx, u, s, source);
        const allAssignments = Object.fromEntries(
          plan.rooms.map((r) => [r.room_id, r.attendant_id]),
        );
        const projection = resolveWorksheetCoverage(
          coverageRows(plan.supervisors),
          allRooms,
          allAssignments,
          team,
        );
        const rooms = allRooms.filter(
          (r) =>
            a.manager ||
            (a.self?.job_role === "supervisor"
              ? projection.roomOwners[r.id] === u.id
              : assignments[r.id] === u.id),
        );
        const warnings: string[] = [];
        if (projection.conflictFloors.length)
          warnings.push(
            "Conflicting primary supervisor assignment. Manager review required for floors: " +
              projection.conflictFloors.join(", "),
          );
        if (a.manager && Object.keys(projection.roomExceptions).length)
          warnings.push(
            "Room-specific supervisor exceptions preserve existing work or explicit coverage. Review Floor Assignment before transferring a team.",
          );
        const credits = attendants
          .filter((a) => a.active && a.available)
          .map((a) =>
            rooms
              .filter((r) => assignments[r.id] === a.id)
              .reduce((sum, r) => sum + (r.credits || 0), 0),
          );
        const mean = credits.length
          ? credits.reduce((a, b) => a + b, 0) / credits.length
          : 0;
        if (credits.length > 1 && mean > 0 && Math.max(...credits) > mean * 1.5)
          warnings.push(
            "Workload imbalance: an attendant exceeds 150% of the available team average.",
          );
        return {
          scope: s,
          property,
          shift,
          revision: await revision(tx, u, s.propertyId),
          savedAt:
            (
              (
                await tx.execute(
                  sql`SELECT created_at FROM housekeeping_worksheet_changes WHERE ${where(u, s)} ORDER BY created_at DESC LIMIT 1`,
                )
              ).rows[0] as Row | undefined
            )?.created_at || null,
          selfRole: a.manager ? "manager" : a.self?.job_role || null,
          manager: a.manager,
          canManage: !!(
            a.manager ||
            (a.self?.job_role === "supervisor" &&
              schedules.find((r) => r.user_id === u.id)?.available === true &&
              (a.self.can_manage ||
                rooms.length > 0 ||
                plan.supervisors.some(
                  (r) => r.supervisor_id === u.id && r.floors.length > 0,
                )))
          ),
          rosterConfigured: schedules.some((r) => r.available),
          rooms,
          floorAssignments: worksheetFloorRows(
            rooms,
            assignments,
            projection,
            a.manager
              ? plan.supervisors.flatMap((r) => r.floors)
              : a.self?.job_role === "supervisor"
                ? plan.supervisors.find((r) => r.supervisor_id === u.id)
                    ?.floors || []
                : [],
          ),
          supervisorFloors: Object.fromEntries(
            [...visibleSupervisorIds].map((uid) => [
              uid,
              a.self?.job_role === "attendant"
                ? [...new Set(rooms.map((r) => r.floor).filter(Boolean))]
                : plan.supervisors.find((r) => r.supervisor_id === uid)
                    ?.floors || [],
            ]),
          ),
          roomSupervisors: Object.fromEntries(
            rooms.map((r) => [r.id, projection.roomOwners[r.id] || null]),
          ),
          roomExceptions: Object.fromEntries(
            rooms
              .filter((r) => projection.roomExceptions[r.id])
              .map((r) => [r.id, projection.roomExceptions[r.id]]),
          ),
          supervisors,
          attendants,
          team: Object.fromEntries(
            Object.entries(team).filter(([att]) =>
              visibleAttendantIds.has(att),
            ),
          ),
          assignments,
          localProgress,
          feed: {
            source: source.source,
            available: source.available,
            status: source.status,
            error: source.error,
            taskError: source.taskError,
            syncedAt: source.syncedAt,
            stale:
              source.source === "OHIP" &&
              (source.status !== "synced" ||
                !source.syncedAt ||
                Date.now() - new Date(source.syncedAt).getTime() > 180000),
          },
          missingAssignedRooms: plan.rooms.filter(
            (r) =>
              visibleAttendantIds.has(r.attendant_id) &&
              !allRooms.some((t) => t.id === r.room_id),
          ).length,
          warnings,
        };
      },
      { isolationLevel: "repeatable read" },
    );
  }
  app.get("/api/local-housekeeping/worksheet", async (req) => {
    const s = scopeSchema.parse(req.query),
      u = req.principal;
    const source = await currentFeed(u, s);
    return getWorksheet(u, s, source);
  });
  app.get("/api/local-housekeeping/worksheet/print", async (req) => {
    const { revision: expected, ...s } = scopeSchema
      .extend({ revision: z.string().regex(/^\d+$/) })
      .strict()
      .parse(req.query);
    const source = await currentFeed(req.principal, s);
    const sheet = await getWorksheet(req.principal, s, source);
    if (sheet.revision !== expected)
      throw fail(
        409,
        "Saved worksheet revision changed. Refresh the worksheet and retry print.",
      );
    if (!sheet.feed.available || sheet.missingAssignedRooms)
      throw fail(
        409,
        "Print reconciliation failed: assigned rooms are missing from the authorized room feed. Restore the feed before printing.",
      );
    const ids = new Set(sheet.rooms.map((r) => r.id));
    if (
      ids.size !== sheet.rooms.length ||
      Object.keys(sheet.assignments).some((id) => !ids.has(id)) ||
      Object.values(sheet.assignments).some((uid) => !sheet.team[uid])
    )
      throw fail(
        409,
        "Print reconciliation failed: assignment room/team counts do not match. Refresh and review assignments.",
      );
    return {
      ...sheet,
      reconciliation: {
        assignedRooms: Object.keys(sheet.assignments).length,
        attendants: sheet.attendants.map((a) => {
          const rooms = sheet.rooms.filter(
            (r) => sheet.assignments[r.id] === a.id,
          );
          return {
            id: a.id,
            rooms: rooms.length,
            credits:
              Math.round(
                rooms.reduce((n, r) => n + (r.credits ?? 0), 0) * 100,
              ) / 100,
            missingCredits: rooms.filter((r) => r.credits === null).length,
          };
        }),
      },
    };
  });
  const operations = z
    .array(
      z.discriminatedUnion("type", [
        z
          .object({
            type: z.literal("schedule"),
            userIds: z
              .array(id)
              .min(1)
              .max(100)
              .refine((v) => new Set(v).size === v.length),
          })
          .strict(),
        z
          .object({
            type: z.literal("distribute"),
            roomIds: z
              .array(id)
              .min(1)
              .max(1000)
              .refine((v) => new Set(v).size === v.length),
            attendantIds: z
              .array(id)
              .min(1)
              .max(100)
              .refine((v) => new Set(v).size === v.length),
            mode: z.enum(["equal", "credits"]),
          })
          .strict(),
        z
          .object({
            type: z.literal("rooms"),
            roomIds: z
              .array(id)
              .min(1)
              .max(1000)
              .refine(
                (v) => new Set(v).size === v.length,
                "Duplicate room selection",
              ),
            attendantId: id.nullable(),
          })
          .strict(),
        z
          .object({
            type: z.literal("team"),
            attendantId: id,
            supervisorId: id,
          })
          .strict(),
        z
          .object({
            type: z.literal("floors"),
            floorIds: z
              .array(id)
              .min(1)
              .max(1000)
              .refine(
                (v) => new Set(v).size === v.length,
                "Duplicate floor selection",
              ),
            supervisorId: id.nullable(),
            replace: z.boolean().default(false),
          })
          .strict(),
        z
          .object({
            type: z.literal("coverage"),
            roomIds: z
              .array(id)
              .min(1)
              .max(1000)
              .refine(
                (v) => new Set(v).size === v.length,
                "Duplicate room selection",
              ),
            supervisorId: id.nullable(),
          })
          .strict(),
      ]),
    )
    .min(1)
    .max(1000);
  const mutationSchema = scopeSchema.extend({
    baseRevision: z.string().regex(/^\d+$/).max(30),
    mutationId: z.uuid(),
    operations,
  });
  const undoSchema = scopeSchema.extend({
    baseRevision: z.string().regex(/^\d+$/).max(30),
    mutationId: z.uuid(),
    changeId: z.uuid(),
  });

  async function apply(
    tx: Tx,
    u: Principal,
    s: WorksheetScope,
    a: Access,
    before: Plan,
    team: Map<string, string>,
    assignments: Map<string, string>,
    source: RoomFeed,
    restore?: Plan,
    supervisorIntent?: Row[],
  ) {
    const rooms = await enrich(tx, u, s, source),
      roomById = new Map(rooms.map((r) => [r.id, r]));
    const schedules = (
      await tx.execute(
        sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE ${where(u, s)}`,
      )
    ).rows as Row[];
    const available = (uid: string, role: string) =>
      a.staff.some((r) => r.user_id === uid && r.job_role === role) &&
      schedules.find((r) => r.user_id === uid)?.available === true;
    const beforeProjection = resolveWorksheetCoverage(
      coverageRows(before.supervisors),
      rooms,
      Object.fromEntries(before.rooms.map((r) => [r.room_id, r.attendant_id])),
      Object.fromEntries(
        before.attendants.map((r) => [r.attendant_id, r.supervisor_id]),
      ),
    );
    const authorized = !!(
      a.self?.job_role === "supervisor" &&
      available(u.id, "supervisor") &&
      (a.self.can_manage ||
        before.supervisors.some(
          (r) => r.supervisor_id === u.id && r.floors.length,
        ) ||
        Object.values(beforeProjection.roomOwners).includes(u.id))
    );
    if (!a.manager && !authorized)
      throw fail(403, "Local assignment management not authorized");
    const beforeAssignments = new Map<string, string>(
      before.rooms.map((r) => [r.room_id, r.attendant_id]),
    );
    const beforeTeam = new Map<string, string>(
      before.attendants.map((r) => [r.attendant_id, r.supervisor_id]),
    );
    const changedRooms = new Set(
      [...assignments.keys(), ...beforeAssignments.keys()].filter(
        (room) => assignments.get(room) !== beforeAssignments.get(room),
      ),
    );
    const changedTeam = new Set(
      [...team.keys()].filter((uid) => team.get(uid) !== beforeTeam.get(uid)),
    );
    if (!a.manager) {
      for (const uid of changedTeam)
        if (
          (beforeTeam.has(uid) && beforeTeam.get(uid) !== u.id) ||
          team.get(uid) !== u.id
        )
          throw fail(
            403,
            "Only managers may move attendants between supervisors",
          );
      for (const room of changedRooms) {
        const old = beforeAssignments.get(room),
          next = assignments.get(room);
        if (
          (old && beforeTeam.get(old) !== u.id) ||
          (next && team.get(next) !== u.id) ||
          beforeProjection.roomOwners[room] !== u.id
        )
          throw fail(403, "Room is outside your authorized team coverage");
      }
    }
    for (const roomId of changedRooms) {
      const uid = assignments.get(roomId);
      if (!uid) continue;
      if (!source.available || !roomById.has(roomId))
        throw fail(
          409,
          "Current authorized OPERA room data is unavailable. Assignment was not saved.",
        );
      if (!available(uid, "attendant"))
        throw fail(
          409,
          "Attendant is inactive or unavailable for this date and shift",
        );
      const supervisor = team.get(uid);
      if (!supervisor || !available(supervisor, "supervisor"))
        throw fail(
          409,
          "Choose an available registered supervisor for this attendant first",
        );
    }
    for (const uid of changedTeam) {
      if (
        !available(uid, "attendant") ||
        !available(team.get(uid)!, "supervisor")
      )
        throw fail(
          409,
          "Staff is inactive or unavailable for this date and shift",
        );
      for (const [rid, att] of assignments)
        if (att === uid && (!source.available || !roomById.has(rid)))
          throw fail(
            409,
            "Cannot move a team with rooms missing from the authorized feed",
          );
    }
    const intent =
      supervisorIntent || restore?.supervisors || before.supervisors;
    const projected = resolveWorksheetCoverage(
      coverageRows(intent),
      rooms,
      Object.fromEntries(assignments),
      Object.fromEntries(team),
    );
    if (projected.conflictFloors.length)
      throw fail(
        409,
        "A floor may have only one primary supervisor in the same date and shift",
      );
    for (const row of intent) {
      const old = before.supervisors.find(
        (r) => r.supervisor_id === row.supervisor_id,
      );
      if (
        row.floors.some((f: string) => !old?.floors.includes(f)) ||
        row.rooms.some((r: string) => !old?.rooms.includes(r))
      ) {
        if (!available(row.supervisor_id, "supervisor"))
          throw fail(
            409,
            "Supervisor is inactive or unavailable for this date and shift",
          );
      }
    }
    for (const uid of assignments.values())
      if (!team.has(uid)) throw fail(409, "Attendant has no supervisor");
    const coverage = new Map<string, Set<string>>();
    for (const [room, owner] of Object.entries(projected.roomOwners))
      if (owner) {
        if (!coverage.has(owner)) coverage.set(owner, new Set());
        coverage.get(owner)!.add(room);
      }
    for (const supervisor of new Set([
      ...team.values(),
      ...coverage.keys(),
      ...before.supervisors.map((r) => r.supervisor_id),
      ...intent.map((r) => r.supervisor_id),
    ])) {
      const old = before.supervisors.find(
          (r) => r.supervisor_id === supervisor,
        ),
        restored = intent.find((r) => r.supervisor_id === supervisor);
      const ids = [...(coverage.get(supervisor) || [])].sort();
      const floors = [...new Set<string>(restored?.floors || [])].sort();
      const exceptions = Object.entries(projected.roomExceptions)
        .filter(([, owner]) => owner === supervisor)
        .map(([id]) => id)
        .sort();
      const unchanged =
        old &&
        JSON.stringify([...old.coverage].sort()) === JSON.stringify(ids) &&
        JSON.stringify([...old.floors].sort()) === JSON.stringify(floors) &&
        JSON.stringify([...old.rooms].sort()) === JSON.stringify(exceptions);
      if (!old) {
        if (!available(supervisor, "supervisor"))
          throw fail(409, "Supervisor is not eligible");
      }
      if (!unchanged || !old)
        await tx.execute(
          sql`INSERT INTO housekeeping_supervisor_assignments VALUES (${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${supervisor},${JSON.stringify(floors)}::jsonb,${JSON.stringify(exceptions)}::jsonb,${JSON.stringify(ids)}::jsonb) ON CONFLICT(tenant_id,property_id,business_date,shift_id,supervisor_id) DO UPDATE SET floors=excluded.floors,rooms=excluded.rooms,coverage=excluded.coverage`,
        );
    }
    for (const [uid, supervisor] of team) {
      if (beforeTeam.get(uid) === supervisor && !restore) continue;
      const original = restore?.attendants.find((r) => r.attendant_id === uid);
      await tx.execute(
        sql`INSERT INTO housekeeping_attendant_assignments(tenant_id,property_id,business_date,shift_id,attendant_id,supervisor_id,floors,sections,rooms) VALUES (${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${uid},${supervisor},${JSON.stringify(original?.floors || [])}::jsonb,${JSON.stringify(original?.sections || [])}::jsonb,${JSON.stringify(original?.rooms || [])}::jsonb) ON CONFLICT(tenant_id,property_id,business_date,shift_id,attendant_id) DO UPDATE SET supervisor_id=excluded.supervisor_id,floors=excluded.floors,sections=excluded.sections,rooms=excluded.rooms,worksheet_active=true`,
      );
    }
    for (const rid of changedRooms) {
      const old = before.rooms.find((r) => r.room_id === rid),
        uid = assignments.get(rid),
        r = roomById.get(rid);
      if (!uid) {
        if (old)
          await tx.execute(
            sql`UPDATE housekeeping_room_assignments SET active=false,local_status='released',updated_at=now() WHERE id=${old.id}`,
          );
        continue;
      }
      if (!r) throw fail(409, "Room no longer present in feed");
      const d = (
        await tx.execute(
          sql`SELECT 1 FROM housekeeping_room_directory WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND room_id=${rid}`,
        )
      ).rows.length;
      if (!d)
        await tx.execute(
          sql`INSERT INTO housekeeping_room_directory(tenant_id,property_id,room_id,floor,section,departure_credits,stayover_credits,other_credits,validated_by,location_source,credits_configured) VALUES (${u.tenantId},${s.propertyId},${rid},${r.floor || ""},${r.section || ""},0,0,0,${u.id},'OHIP',false)`,
        );
      const original = restore?.rooms.find((r) => r.room_id === rid);
      if (old)
        await tx.execute(
          sql`UPDATE housekeeping_room_assignments SET attendant_id=${uid},local_status=${original?.local_status || old.local_status},updated_at=now() WHERE id=${old.id}`,
        );
      else
        await tx.execute(
          sql`INSERT INTO housekeeping_room_assignments(id,tenant_id,property_id,business_date,shift_id,attendant_id,room_id,baseline_status,baseline_attention,baseline_at,local_status) VALUES (${randomUUID()},${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${uid},${rid},${original?.baseline_status || r.status},${original?.baseline_attention || r.remarks.join("; ")},${original?.baseline_at || r.observedAt},${original?.local_status || "assigned"})`,
        );
    }
    if (restore) {
      // Remove links created by the undone action only after their active rooms have moved.
      for (const old of before.attendants)
        if (
          !restore.attendants.some((r) => r.attendant_id === old.attendant_id)
        ) {
          // Released room history references this team link; keep the link without active work.
          // This is intentional: undo restores work and coverage, never deletes history.
          await tx.execute(
            sql`UPDATE housekeeping_attendant_assignments SET floors='[]',sections='[]',rooms='[]',worksheet_active=false WHERE ${where(u, s)} AND attendant_id=${old.attendant_id}`,
          );
        }
    }
  }
  async function mutate(
    u: Principal,
    b: z.infer<typeof mutationSchema> | z.infer<typeof undoSchema>,
    undo = false,
  ) {
    const s: WorksheetScope = {
      propertyId: b.propertyId,
      date: b.date,
      shiftId: b.shiftId,
    };
    const source = await currentFeed(u, s);
    return h.locked(u, s.propertyId, async (tx) => {
      await assertPrincipal(tx, u, s.propertyId);
      await assertFeed(tx, u, s, source);
      const a = await h.access(tx, u, s.propertyId);
      if (!a.manager && a.self?.job_role !== "supervisor")
        throw fail(403, "Assignment management not authorized");
      const hash = createHash("sha256").update(JSON.stringify(b)).digest("hex");
      const repeated = (
        await tx.execute(
          sql`SELECT * FROM housekeeping_worksheet_changes WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND mutation_id=${b.mutationId}`,
        )
      ).rows[0] as Row | undefined;
      if (repeated) {
        if (repeated.actor !== u.id || repeated.request_hash !== hash)
          throw fail(409, "Mutation identifier has already been used");
        return {
          revision: repeated.result_revision,
          changeId: repeated.id,
          replayed: true,
        };
      }
      const currentRevision = await revision(tx, u, s.propertyId);
      if (currentRevision !== b.baseRevision)
        throw fail(
          409,
          "Worksheet changed by another user. Your pending changes were rolled back; review the refreshed worksheet.",
        );
      if (
        !(
          await tx.execute(
            sql`SELECT 1 FROM housekeeping_shifts WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND id=${s.shiftId} AND active`,
          )
        ).rows.length
      )
        throw fail(404, "Shift not found");
      const before = await loadPlan(tx, u, s),
        team = new Map<string, string>(
          before.attendants.map((r) => [r.attendant_id, r.supervisor_id]),
        ),
        assignments = new Map<string, string>(
          before.rooms.map((r) => [r.room_id, r.attendant_id]),
        );
      let restore: Plan | undefined,
        undoOf: string | null = null;
      let supervisorIntent = cloneSupervisors(before.supervisors);
      let undoPlan = {
        team: Object.fromEntries(team),
        assignments: Object.fromEntries(assignments),
        supervisors: cloneSupervisors(supervisorIntent),
        schedules: undefined as Plan["schedules"],
      };
      const scheduledIds = !undo
        ? [
            ...new Set(
              (b as z.infer<typeof mutationSchema>).operations.flatMap((op) =>
                op.type === "schedule" ? op.userIds : [],
              ),
            ),
          ]
        : [];
      if (scheduledIds.length) {
        if (!a.manager)
          throw fail(403, "Only managers can add staff to a shift");
        for (const uid of scheduledIds)
          if (
            !a.staff.some(
              (staff) =>
                staff.user_id === uid &&
                ["supervisor", "attendant"].includes(staff.job_role),
            )
          )
            throw fail(
              403,
              "Select active registered staff with the correct role and property access",
            );
        const previous = (
          await tx.execute(
            sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE ${where(u, s)}`,
          )
        ).rows as Row[];
        before.schedules = scheduledIds.map((user_id) => ({
          user_id,
          available:
            previous.find((row) => row.user_id === user_id)?.available ?? null,
        }));
        undoPlan.schedules = before.schedules;
        for (const uid of scheduledIds)
          await tx.execute(
            sql`INSERT INTO housekeeping_staff_schedules VALUES (${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${uid},true) ON CONFLICT(tenant_id,property_id,business_date,shift_id,user_id) DO UPDATE SET available=true`,
          );
      }
      if (undo) {
        const change = (
          await tx.execute(
            sql`SELECT * FROM housekeeping_worksheet_changes WHERE ${where(u, s)} AND id=${(b as z.infer<typeof undoSchema>).changeId} AND actor=${u.id} AND result_revision=${b.baseRevision} AND undo_of IS NULL`,
          )
        ).rows[0] as Row | undefined;
        if (!change)
          throw fail(
            409,
            "Only your last unchanged worksheet move can be undone",
          );
        const target = change.undo_plan;
        if (target.schedules?.length && !a.manager)
          throw fail(403, "Only managers can undo shift scheduling");
        if (target.schedules?.length) {
          const current = (
            await tx.execute(
              sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE ${where(u, s)}`,
            )
          ).rows as Row[];
          before.schedules = target.schedules.map((row: Row) => ({
            user_id: row.user_id,
            available:
              current.find((r) => r.user_id === row.user_id)?.available ?? null,
          }));
        }
        restore = {
          supervisors: target.supervisors || change.before_plan.supervisors,
          attendants: Object.entries(target.team).map(([uid, spv]) => ({
            ...change.before_plan.attendants.find(
              (r: Row) => r.attendant_id === uid,
            ),
            attendant_id: uid,
            supervisor_id: spv,
          })),
          rooms: Object.entries(target.assignments).map(([rid, uid]) => ({
            ...change.before_plan.rooms.find((r: Row) => r.room_id === rid),
            ...change.after_plan.rooms.find((r: Row) => r.room_id === rid),
            room_id: rid,
            attendant_id: uid,
          })),
          schedules: target.schedules,
        };
        undoOf = change.id;
        supervisorIntent = cloneSupervisors(restore.supervisors);
        assignments.clear();
        for (const r of restore!.rooms)
          assignments.set(r.room_id, r.attendant_id);
        team.clear();
        for (const r of restore!.attendants)
          team.set(r.attendant_id, r.supervisor_id);
      } else {
        const verifiedRooms = await enrich(tx, u, s, source),
          verifiedIds = new Set(verifiedRooms.map((r) => r.id));
        const coverageEdits = new Map<string, string | null>();
        const ensureSupervisor = (uid: string) => {
          let row = supervisorIntent.find((r) => r.supervisor_id === uid);
          if (!row) {
            row = { supervisor_id: uid, floors: [], rooms: [], coverage: [] };
            supervisorIntent.push(row);
          }
          return row;
        };
        for (const op of (b as z.infer<typeof mutationSchema>).operations) {
          if (op.type === "schedule") continue;
          if (!scheduledIds.length)
            undoPlan = {
              team: Object.fromEntries(team),
              assignments: Object.fromEntries(assignments),
              supervisors: cloneSupervisors(supervisorIntent),
              schedules: before.schedules,
            };
          if (op.type === "distribute") {
            if (
              !source.available ||
              op.roomIds.some((rid) => !verifiedIds.has(rid))
            )
              throw fail(
                409,
                "Selected rooms are absent from the current authorized feed. Refresh and retry.",
              );
            if (!a.manager) {
              const ownership = resolveWorksheetCoverage(
                coverageRows(before.supervisors),
                verifiedRooms,
                Object.fromEntries(
                  before.rooms.map((r) => [r.room_id, r.attendant_id]),
                ),
                Object.fromEntries(
                  before.attendants.map((r) => [
                    r.attendant_id,
                    r.supervisor_id,
                  ]),
                ),
              );
              if (op.roomIds.some((rid) => ownership.roomOwners[rid] !== u.id))
                throw fail(
                  403,
                  "Selected rooms include work outside your supervisor coverage",
                );
              if (
                op.attendantIds.some(
                  (uid) => team.has(uid) && team.get(uid) !== u.id,
                )
              )
                throw fail(
                  403,
                  "Selected attendants include another supervisor team",
                );
            }
            const roster = (
              await tx.execute(
                sql`SELECT user_id FROM housekeeping_staff_schedules WHERE ${where(u, s)} AND available`,
              )
            ).rows;
            for (const uid of op.attendantIds) {
              if (
                !a.staff.some(
                  (r) => r.user_id === uid && r.job_role === "attendant",
                ) ||
                !roster.some((r) => r.user_id === uid)
              )
                throw fail(
                  409,
                  `Attendant ${uid} is not active and rostered for this shift`,
                );
              if (!team.has(uid) && !a.manager) team.set(uid, u.id);
              if (!team.has(uid))
                throw fail(
                  409,
                  "Place target attendants under a supervisor first",
                );
            }
            const distribution = distributeRooms(
              {
                rooms: verifiedRooms,
                assignments: Object.fromEntries(assignments),
              },
              op.roomIds,
              op.attendantIds,
              op.mode,
            );
            for (const row of distribution.rows)
              for (const rid of row.roomIds)
                assignments.set(rid, row.attendantId);
          } else if (op.type === "team")
            team.set(op.attendantId, op.supervisorId);
          else if (op.type === "floors") {
            if (!a.manager)
              throw fail(403, "Only managers can assign primary floors");
            for (const floor of op.floorIds) {
              if (
                op.supervisorId &&
                (!source.available ||
                  !verifiedRooms.some((r) => r.floor === floor))
              )
                throw fail(
                  409,
                  "Floor must exist in the current verified room feed",
                );
              const owners = supervisorIntent.filter((r) =>
                r.floors.includes(floor),
              );
              if (
                op.supervisorId &&
                !op.replace &&
                owners.some((r) => r.supervisor_id !== op.supervisorId)
              )
                throw fail(
                  409,
                  "Floor already has a primary supervisor; choose an explicit replacement",
                );
              for (const row of supervisorIntent) {
                row.floors = row.floors.filter((f: string) => f !== floor);
                row.coverage = row.coverage.filter(
                  (id: string) =>
                    !verifiedRooms.some(
                      (r) => r.id === id && r.floor === floor,
                    ),
                );
              }
              if (op.supervisorId)
                ensureSupervisor(op.supervisorId).floors.push(floor);
            }
          } else if (op.type === "coverage") {
            if (!a.manager)
              throw fail(
                403,
                "Only managers can set room-specific supervisor exceptions",
              );
            for (const rid of op.roomIds) {
              if (
                op.supervisorId &&
                (!source.available || !verifiedIds.has(rid))
              )
                throw fail(
                  409,
                  "Exception room must exist in the current verified feed",
                );
              for (const row of supervisorIntent) {
                row.rooms = row.rooms.filter((r: string) => r !== rid);
                row.coverage = row.coverage.filter((r: string) => r !== rid);
              }
              if (op.supervisorId)
                ensureSupervisor(op.supervisorId).rooms.push(rid);
              coverageEdits.set(rid, op.supervisorId);
            }
          } else
            for (const room of op.roomIds) {
              if (op.attendantId === null) assignments.delete(room);
              else assignments.set(room, op.attendantId);
            }
        }
        const planned = resolveWorksheetCoverage(
          coverageRows(supervisorIntent),
          verifiedRooms,
          {},
          {},
        );
        for (const [rid, exception] of coverageEdits) {
          const att = assignments.get(rid);
          if (att && team.get(att) !== (exception || planned.roomOwners[rid]))
            throw fail(
              409,
              "Existing attendant work must stay with its team; move the room or team before clearing/changing this exception",
            );
        }
      }
      await apply(
        tx,
        u,
        s,
        a,
        before,
        team,
        assignments,
        source,
        restore,
        supervisorIntent,
      );
      const after = await loadPlan(tx, u, s),
        changeId = randomUUID();
      if (restore?.schedules) {
        for (const row of restore.schedules)
          await tx.execute(
            sql`UPDATE housekeeping_staff_schedules SET available=${row.available === true} WHERE ${where(u, s)} AND user_id=${row.user_id}`,
          );
      }
      if (scheduledIds.length || restore?.schedules)
        after.schedules = (
          await tx.execute(
            sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE ${where(u, s)}`,
          )
        ).rows as { user_id: string; available: boolean }[];
      await h.changed(
        tx,
        u,
        s.propertyId,
        undo ? "worksheet.undo" : "worksheet.move",
        changeId,
        { date: s.date, shiftId: s.shiftId },
      );
      const resultRevision = await revision(tx, u, s.propertyId);
      await tx.execute(
        sql`INSERT INTO housekeeping_worksheet_changes(id,tenant_id,property_id,business_date,shift_id,actor,mutation_id,request_hash,base_revision,result_revision,before_plan,after_plan,undo_plan,undo_of) VALUES (${changeId},${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${u.id},${b.mutationId},${hash},${b.baseRevision},${resultRevision},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${JSON.stringify(undoPlan)}::jsonb,${undoOf})`,
      );
      return { revision: resultRevision, changeId, replayed: false };
    });
  }
  app.put("/api/local-housekeeping/worksheet", async (req) =>
    mutate(req.principal, mutationSchema.parse(req.body)),
  );
  app.post("/api/local-housekeeping/worksheet/undo", async (req) =>
    mutate(req.principal, undoSchema.parse(req.body), true),
  );
}
