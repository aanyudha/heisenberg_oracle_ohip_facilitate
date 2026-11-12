import type { FastifyInstance } from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type {
  Worksheet,
  WorksheetScope,
  WorksheetRoom,
} from "@hospitality/contracts";
import { sql, type Database } from "./db.js";
import type { Principal } from "./realtime.js";
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
type Plan = { supervisors: Row[]; attendants: Row[]; rooms: Row[] };
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
      const override = d?.location_source === "local_validated" && d.floor;
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
            sql`SELECT id,name FROM housekeeping_shifts WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND id=${s.shiftId}`,
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
                (r) => r.job_role === "attendant" && team[r.user_id] === u.id,
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
        const names = (
          await tx.execute(
            sql`SELECT u.id,u.name FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=${u.tenantId}`,
          )
        ).rows as Row[];
        const staff = (ids: Set<string>, role: string) =>
          [...ids].map((uid) => ({
            id: uid,
            name:
              names.find((r) => r.id === uid)?.name ||
              "Unavailable registered staff",
            active: a.staff.some(
              (r) => r.user_id === uid && r.job_role === role,
            ),
            available:
              schedules.find((r) => r.user_id === uid)?.available !== false,
          }));
        const attendants = staff(visibleAttendantIds, "attendant"),
          supervisors = staff(visibleSupervisorIds, "supervisor");
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
        const coverage =
          plan.supervisors.find((r) => r.supervisor_id === u.id)?.coverage ||
          [];
        const allRooms = await enrich(tx, u, s, source);
        const rooms = allRooms.filter(
          (r) =>
            a.manager ||
            (a.self?.job_role === "supervisor"
              ? coverage.includes(r.id) || !!assignments[r.id]
              : assignments[r.id] === u.id),
        );
        const warnings: string[] = [];
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
        if (rooms.some((r) => r.creditSource === "not_configured"))
          warnings.push(
            "Credits not configured for some rooms. Totals show known credits only.",
          );
        if (
          attendants.some((r) => !r.active || !r.available) ||
          supervisors.some((r) => !r.active || !r.available)
        )
          warnings.push(
            "Some assigned staff are inactive or unavailable. Release or reassign their local rooms.",
          );
        return {
          scope: s,
          property,
          shift,
          revision: await revision(tx, u, s.propertyId),
          selfRole: a.manager ? "manager" : a.self?.job_role || null,
          manager: a.manager,
          canManage: !!(
            a.manager ||
            (a.self?.job_role === "supervisor" && a.self.can_manage)
          ),
          rooms,
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
  const operations = z
    .array(
      z.discriminatedUnion("type", [
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
      schedules.find((r) => r.user_id === uid)?.available !== false;
    const authorized = !!(
      a.self?.job_role === "supervisor" && a.self.can_manage
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
        if (beforeTeam.get(uid) !== u.id || team.get(uid) !== u.id)
          throw fail(
            403,
            "Only managers may move attendants between supervisors",
          );
      const coverage =
        before.supervisors.find((r) => r.supervisor_id === u.id)?.coverage ||
        [];
      for (const room of changedRooms) {
        const old = beforeAssignments.get(room),
          next = assignments.get(room);
        if (
          (old && beforeTeam.get(old) !== u.id) ||
          (next && team.get(next) !== u.id) ||
          (!old && !coverage.includes(room))
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
    const affectedStaff = new Set<string>();
    for (const uid of changedTeam) {
      affectedStaff.add(uid);
      affectedStaff.add(team.get(uid)!);
    }
    for (const rid of changedRooms) {
      const uid = assignments.get(rid);
      if (uid) {
        affectedStaff.add(uid);
        affectedStaff.add(team.get(uid)!);
      }
    }
    // Roster membership is enough to start a worksheet; no daily availability form is required.
    for (const uid of affectedStaff)
      await tx.execute(
        sql`INSERT INTO housekeeping_staff_schedules VALUES (${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${uid},true) ON CONFLICT DO NOTHING`,
      );
    const coverage = new Map<string, Set<string>>();
    for (const v of restore?.supervisors || before.supervisors)
      coverage.set(v.supervisor_id, new Set(v.coverage));
    for (const [room, uid] of assignments) {
      const supervisor = team.get(uid);
      if (!supervisor) throw fail(409, "Attendant has no supervisor");
      for (const [spv, values] of coverage)
        if (spv !== supervisor) values.delete(room);
      if (!coverage.has(supervisor)) coverage.set(supervisor, new Set());
      coverage.get(supervisor)!.add(room);
    }
    for (const supervisor of new Set([
      ...team.values(),
      ...coverage.keys(),
      ...before.supervisors.map((r) => r.supervisor_id),
    ])) {
      const old = before.supervisors.find(
          (r) => r.supervisor_id === supervisor,
        ),
        restored = restore?.supervisors.find(
          (r) => r.supervisor_id === supervisor,
        );
      const ids = [...(coverage.get(supervisor) || [])].sort();
      const unchanged =
        old && JSON.stringify([...old.coverage].sort()) === JSON.stringify(ids);
      if (!old) {
        if (!available(supervisor, "supervisor"))
          throw fail(409, "Supervisor is not eligible");
        await tx.execute(
          sql`INSERT INTO housekeeping_staff_schedules VALUES (${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${supervisor},true) ON CONFLICT DO NOTHING`,
        );
      }
      if (!unchanged || restored || !old)
        await tx.execute(
          sql`INSERT INTO housekeeping_supervisor_assignments VALUES (${u.tenantId},${s.propertyId},${s.date},${s.shiftId},${supervisor},${JSON.stringify(restored?.floors || (unchanged ? old?.floors : []) || [])}::jsonb,${JSON.stringify(restored?.rooms || ids)}::jsonb,${JSON.stringify(ids)}::jsonb) ON CONFLICT(tenant_id,property_id,business_date,shift_id,supervisor_id) DO UPDATE SET floors=excluded.floors,rooms=excluded.rooms,coverage=excluded.coverage`,
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
      if (
        !a.manager &&
        !(a.self?.job_role === "supervisor" && a.self.can_manage)
      )
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
            sql`SELECT 1 FROM housekeeping_shifts WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND id=${s.shiftId}`,
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
      let undoPlan = {
        team: Object.fromEntries(team),
        assignments: Object.fromEntries(assignments),
      };
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
        restore = {
          supervisors: change.before_plan.supervisors,
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
        };
        undoOf = change.id;
        assignments.clear();
        for (const r of restore!.rooms)
          assignments.set(r.room_id, r.attendant_id);
        team.clear();
        for (const r of restore!.attendants)
          team.set(r.attendant_id, r.supervisor_id);
      } else {
        for (const op of (b as z.infer<typeof mutationSchema>).operations) {
          undoPlan = {
            team: Object.fromEntries(team),
            assignments: Object.fromEntries(assignments),
          };
          if (op.type === "team") team.set(op.attendantId, op.supervisorId);
          else
            for (const room of op.roomIds) {
              if (op.attendantId === null) assignments.delete(room);
              else assignments.set(room, op.attendantId);
            }
        }
      }
      await apply(tx, u, s, a, before, team, assignments, source, restore);
      const after = await loadPlan(tx, u, s),
        changeId = randomUUID();
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
