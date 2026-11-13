import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Database } from "./db.js";
import { appendEvent, type Principal } from "./realtime.js";
import { registerHousekeepingWorksheet } from "./housekeeping-worksheet.js";

const id = z.string().trim().min(1).max(100);
const list = z.array(id).max(1000).default([]);
const scopeSchema = z
  .object({ propertyId: id, date: z.iso.date(), shiftId: id })
  .strict();
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
type Scope = z.infer<typeof scopeSchema>;
type Row = Record<string, any>;
type Tx = { execute: Database["orm"]["execute"] };
const admins = (u: Principal) =>
  ["platform_admin", "group_admin", "it"].includes(u.role);
const privileged = (u: Principal) => admins(u) || u.role === "hotel_manager";

export function registerHousekeeping(
  app: FastifyInstance,
  db: Database,
  transport?: typeof fetch,
) {
  function property(u: Principal, p: string) {
    if (!u.properties.includes(p)) throw fail(403, "Property access denied");
  }
  async function profiles(tx: Tx, u: Principal, p: string): Promise<Row[]> {
    return (
      await tx.execute(sql`SELECT h.*,u.name,m.role FROM housekeeping_staff_profiles h
      JOIN users u ON u.id=h.user_id JOIN memberships m ON m.tenant_id=h.tenant_id AND m.user_id=h.user_id
      JOIN property_grants g ON g.tenant_id=h.tenant_id AND g.property_id=h.property_id AND g.user_id=h.user_id
      WHERE h.tenant_id=${u.tenantId} AND h.property_id=${p} AND m.role IN ('housekeeping','hotel_manager')
      AND NOT EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=h.tenant_id AND (a.kind='tenants' OR (a.kind='users' AND a.target=h.user_id) OR (a.kind='properties' AND a.target=h.property_id))) ORDER BY u.name`)
    ).rows as Row[];
  }
  async function access(tx: Tx, u: Principal, p: string) {
    property(u, p);
    const staff = await profiles(tx, u, p);
    const self = staff.find((s) => s.user_id === u.id);
    if (!privileged(u) && !self) throw fail(403, "Housekeeping access denied");
    return {
      staff,
      self,
      manager: privileged(u) || self?.job_role === "manager",
    };
  }
  async function changed(
    tx: Tx,
    u: Principal,
    p: string,
    action: string,
    target: string,
    assignmentScope?: { date: string; shiftId: string },
  ) {
    await tx.execute(
      sql`INSERT INTO audit_logs(id,tenant_id,property_id,actor,action,target) VALUES (${randomUUID()},${u.tenantId},${p},${u.id},${"housekeeping." + action},${target})`,
    );
    await appendEvent(
      tx,
      u.tenantId,
      p,
      "housekeeping",
      assignmentScope ? { kind: "assignment", ...assignmentScope } : {},
    );
  }
  async function locked<T>(
    u: Principal,
    p: string,
    fn: (tx: Tx) => Promise<T>,
  ) {
    property(u, p);
    return db.orm.transaction(async (tx) => {
      // Same tenant lock as membership/archive edits, then serialize property plans.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${u.tenantId},7291043001))`,
      );
      const live = (
        await tx.execute(
          sql`SELECT id FROM properties p WHERE tenant_id=${u.tenantId} AND id=${p} AND NOT EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=p.tenant_id AND (a.kind='tenants' OR (a.kind='properties' AND a.target=p.id))) FOR UPDATE`,
        )
      ).rows;
      if (!live.length) throw fail(403, "Property unavailable");
      return fn(tx);
    });
  }
  async function directory(tx: Tx, u: Principal, p: string): Promise<Row[]> {
    return (
      await tx.execute(
        sql`SELECT d.*,coalesce(r.status,'unknown') AS status,coalesce(r.attention,'Room snapshot unavailable') AS attention,r.updated_at FROM housekeeping_room_directory d LEFT JOIN rooms r ON r.tenant_id=d.tenant_id AND r.property_id=d.property_id AND r.id=d.room_id WHERE d.tenant_id=${u.tenantId} AND d.property_id=${p} ORDER BY d.room_id`,
      )
    ).rows as Row[];
  }
  function resolve(
    rows: Row[],
    floors: string[],
    rooms: string[],
    sections: string[] = [],
  ) {
    if (
      floors.some((f) => !rows.some((r) => r.floor === f)) ||
      sections.some((s) => !rows.some((r) => r.section === s)) ||
      rooms.some((r) => !rows.some((d) => d.room_id === r))
    )
      throw fail(400, "Unknown or unvalidated floor, section or room");
    return rows
      .filter(
        (r) =>
          floors.includes(r.floor) ||
          rooms.includes(r.room_id) ||
          (r.section && sections.includes(r.section)),
      )
      .map((r) => r.room_id) as string[];
  }
  async function scheduled(
    tx: Tx,
    u: Principal,
    s: Scope,
    userId: string,
    role: string,
  ) {
    if (
      !(await profiles(tx, u, s.propertyId)).some(
        (r) => r.user_id === userId && r.job_role === role,
      )
    )
      throw fail(
        400,
        "Staff must be active registered Housekeeping staff with the required role and property membership",
      );
    if (
      !(
        await tx.execute(
          sql`SELECT 1 FROM housekeeping_staff_schedules WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND business_date=${s.date} AND shift_id=${s.shiftId} AND user_id=${userId} AND available`,
        )
      ).rows.length
    )
      throw fail(409, "Staff is not available for this date and shift");
  }
  const where = (u: Principal, s: Scope) =>
    sql`tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND business_date=${s.date} AND shift_id=${s.shiftId}`;
  registerHousekeepingWorksheet(
    app,
    db,
    { access, locked, changed },
    transport,
  );

  app.get("/api/local-housekeeping/setup", async (req) => {
    const { propertyId: p } = z.object({ propertyId: id }).parse(req.query);
    const u = req.principal;
    const a = await access(db.orm, u, p);
    return {
      manager: a.manager,
      canConfigureStaff: false,
      canManage:
        a.manager || (a.self?.job_role === "supervisor" && a.self.can_manage),
      selfRole: a.self?.job_role || null,
      shifts: await db.query(
        sql`SELECT id,name,starts_at,ends_at,active FROM housekeeping_shifts WHERE tenant_id=${u.tenantId} AND property_id=${p} ORDER BY starts_at`,
      ),
      staff: a.manager ? a.staff : a.staff.filter((r) => r.user_id === u.id),
      directory: a.manager ? await directory(db.orm, u, p) : [],
      registeredUsers: a.manager
        ? await db.query(
            sql`SELECT u.id,u.name,m.role FROM users u JOIN memberships m ON m.user_id=u.id JOIN property_grants g ON g.tenant_id=m.tenant_id AND g.user_id=m.user_id WHERE m.tenant_id=${u.tenantId} AND g.property_id=${p} AND m.role IN ('housekeeping','hotel_manager') AND NOT EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=m.tenant_id AND a.kind='users' AND a.target=m.user_id) ORDER BY u.name`,
          )
        : [],
      rooms: a.manager
        ? await db.query(
            sql`SELECT id FROM rooms WHERE tenant_id=${u.tenantId} AND property_id=${p} ORDER BY id`,
          )
        : [],
    };
  });
  app.put("/api/local-housekeeping/staff", async (req) => {
    if (!privileged(req.principal))
      throw fail(403, "User Management authorization required");
    throw fail(
      410,
      "Housekeeping roles are managed only in Administration -> Users & Roles",
    );
  });
  app.put("/api/local-housekeeping/shifts", async (req) => {
    const b = z
      .object({
        propertyId: id,
        id,
        name: id,
        startsAt: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .refine((v) => Number(v.slice(0, 2)) < 24 && Number(v.slice(3)) < 60),
        endsAt: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .refine((v) => Number(v.slice(0, 2)) < 24 && Number(v.slice(3)) < 60),
        active: z.boolean().default(true),
      })
      .strict()
      .parse(req.body);
    const u = req.principal;
    return locked(u, b.propertyId, async (tx) => {
      if (!(await access(tx, u, b.propertyId)).manager)
        throw fail(403, "Manager required");
      await tx.execute(
        sql`INSERT INTO housekeeping_shifts(tenant_id,property_id,id,name,starts_at,ends_at,active) VALUES (${u.tenantId},${b.propertyId},${b.id},${b.name},${b.startsAt},${b.endsAt},${b.active}) ON CONFLICT(tenant_id,property_id,id) DO UPDATE SET name=excluded.name,starts_at=excluded.starts_at,ends_at=excluded.ends_at,active=excluded.active`,
      );
      await changed(tx, u, b.propertyId, "shift", b.id);
      return { ok: true };
    });
  });
  app.get("/api/local-housekeeping/roster", async (req) => {
    const s = scopeSchema.parse(req.query),
      u = req.principal;
    return locked(u, s.propertyId, async (tx) => {
      const a = await access(tx, u, s.propertyId);
      if (!a.manager) throw fail(403, "Manager required");
      const schedules = (
        await tx.execute(
          sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE ${where(u, s)}`,
        )
      ).rows;
      return {
        staff: a.staff.map((r) => ({
          id: r.user_id,
          name: r.name,
          role: r.job_role,
          available: schedules.some(
            (t) => t.user_id === r.user_id && t.available,
          ),
        })),
      };
    });
  });
  app.put("/api/local-housekeeping/roster", async (req) => {
    const b = scopeSchema
        .extend({
          userIds: z
            .array(id)
            .max(1000)
            .refine((v) => new Set(v).size === v.length),
        })
        .strict()
        .parse(req.body),
      u = req.principal;
    return locked(u, b.propertyId, async (tx) => {
      const a = await access(tx, u, b.propertyId);
      if (!a.manager) throw fail(403, "Manager required");
      if (b.userIds.some((uid) => !a.staff.some((r) => r.user_id === uid)))
        throw fail(
          400,
          "Select active registered staff with authorized property membership",
        );
      if (
        !(
          await tx.execute(
            sql`SELECT 1 FROM housekeeping_shifts WHERE tenant_id=${u.tenantId} AND property_id=${b.propertyId} AND id=${b.shiftId} AND active`,
          )
        ).rows.length
      )
        throw fail(409, "Select an active shift");
      const old = (
        await tx.execute(
          sql`SELECT user_id FROM housekeeping_staff_schedules WHERE ${where(u, b)} AND available`,
        )
      ).rows;
      for (const r of old.filter(
        (r) => !b.userIds.includes(String(r.user_id)),
      )) {
        if (
          (
            await tx.execute(
              sql`SELECT 1 FROM housekeeping_room_assignments WHERE ${where(u, b)} AND attendant_id=${r.user_id} AND active UNION ALL SELECT 1 FROM housekeeping_supervisor_assignments WHERE ${where(u, b)} AND supervisor_id=${r.user_id} AND (floors!='[]'::jsonb OR rooms!='[]'::jsonb OR coverage!='[]'::jsonb)`,
            )
          ).rows.length
        )
          throw fail(
            409,
            `Staff ${a.staff.find((s) => s.user_id === r.user_id)?.name || r.user_id} still has rooms or supervisor coverage. Reassign/release that work explicitly before removing this staff member.`,
          );
      }
      await tx.execute(
        sql`UPDATE housekeeping_staff_schedules SET available=false WHERE ${where(u, b)}`,
      );
      for (const uid of b.userIds)
        await tx.execute(
          sql`INSERT INTO housekeeping_staff_schedules VALUES (${u.tenantId},${b.propertyId},${b.date},${b.shiftId},${uid},true) ON CONFLICT(tenant_id,property_id,business_date,shift_id,user_id) DO UPDATE SET available=true`,
        );
      await changed(tx, u, b.propertyId, "roster", b.shiftId, {
        date: b.date,
        shiftId: b.shiftId,
      });
      return { ok: true };
    });
  });
  app.put("/api/local-housekeeping/directory", async (req) => {
    const credits = z.number().min(0).max(9999);
    const b = z
      .object({
        propertyId: id,
        roomId: id,
        floor: id,
        section: z.string().trim().max(100).default(""),
        departureCredits: credits,
        stayoverCredits: credits,
        otherCredits: credits.default(0),
        validated: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const u = req.principal;
    return locked(u, b.propertyId, async (tx) => {
      if (!(await access(tx, u, b.propertyId)).manager)
        throw fail(403, "Manager required");
      const old = (await directory(tx, u, b.propertyId)).find(
        (r) => r.room_id === b.roomId,
      );
      if (
        old &&
        (old.floor !== b.floor || old.section !== b.section) &&
        (
          await tx.execute(
            sql`SELECT 1 FROM housekeeping_supervisor_assignments WHERE tenant_id=${u.tenantId} AND property_id=${b.propertyId} AND coverage ? ${b.roomId}`,
          )
        ).rows.length
      )
        throw fail(
          409,
          "Room location is used by an assignment; retain mapping or use a new validated directory version",
        );
      await tx.execute(
        sql`INSERT INTO housekeeping_room_directory(tenant_id,property_id,room_id,floor,section,departure_credits,stayover_credits,other_credits,validated_by) VALUES (${u.tenantId},${b.propertyId},${b.roomId},${b.floor},${b.section},${b.departureCredits},${b.stayoverCredits},${b.otherCredits},${u.id}) ON CONFLICT(tenant_id,property_id,room_id) DO UPDATE SET floor=excluded.floor,section=excluded.section,departure_credits=excluded.departure_credits,stayover_credits=excluded.stayover_credits,other_credits=excluded.other_credits,validated_by=excluded.validated_by,validated_at=now(),location_source='local_validated',credits_configured=true`,
      );
      await changed(tx, u, b.propertyId, "directory", b.roomId);
      return { ok: true };
    });
  });
  app.put("/api/local-housekeeping/schedules", async (req) => {
    const b = scopeSchema
      .extend({ userId: id, available: z.boolean() })
      .parse(req.body);
    const u = req.principal;
    return locked(u, b.propertyId, async (tx) => {
      const a = await access(tx, u, b.propertyId);
      if (!a.manager) throw fail(403, "Manager required");
      if (!a.staff.some((r) => r.user_id === b.userId))
        throw fail(400, "Active registered staff required");
      if (
        !b.available &&
        ((
          await tx.execute(
            sql`SELECT 1 FROM housekeeping_supervisor_assignments WHERE ${where(u, b)} AND supervisor_id=${b.userId} AND coverage!='[]'::jsonb`,
          )
        ).rows.length ||
          (
            await tx.execute(
              sql`SELECT 1 FROM housekeeping_room_assignments WHERE ${where(u, b)} AND attendant_id=${b.userId} AND active`,
            )
          ).rows.length)
      )
        throw fail(
          409,
          "Release room assignments and supervisor coverage before marking unavailable",
        );
      await tx.execute(
        sql`INSERT INTO housekeeping_staff_schedules VALUES (${u.tenantId},${b.propertyId},${b.date},${b.shiftId},${b.userId},${b.available}) ON CONFLICT(tenant_id,property_id,business_date,shift_id,user_id) DO UPDATE SET available=excluded.available`,
      );
      await changed(tx, u, b.propertyId, "schedule", b.userId);
      return { ok: true };
    });
  });
  app.put("/api/local-housekeeping/supervisors", async (req) => {
    const b = scopeSchema
      .extend({ supervisorId: id, floors: list, rooms: list })
      .parse(req.body);
    const u = req.principal;
    return locked(u, b.propertyId, async (tx) => {
      if (!(await access(tx, u, b.propertyId)).manager)
        throw fail(403, "Manager required");
      const coverage = resolve(
        await directory(tx, u, b.propertyId),
        b.floors,
        b.rooms,
      );
      const existingCoverage = (
        await tx.execute(
          sql`SELECT 1 FROM housekeeping_supervisor_assignments WHERE ${where(u, b)} AND supervisor_id=${b.supervisorId}`,
        )
      ).rows.length;
      // Releasing an existing plan must remain possible after staff deactivation.
      if (coverage.length || !existingCoverage)
        await scheduled(tx, u, b, b.supervisorId, "supervisor");
      const others = (
        await tx.execute(
          sql`SELECT floors,coverage FROM housekeeping_supervisor_assignments WHERE ${where(u, b)} AND supervisor_id!=${b.supervisorId}`,
        )
      ).rows as Row[];
      if (
        others.some((r) =>
          r.floors.some((floor: string) => b.floors.includes(floor)),
        )
      )
        throw fail(
          409,
          "Floor already has a primary supervisor for this date and shift",
        );
      if (
        others.some((r) =>
          r.coverage.some((room: string) => coverage.includes(room)),
        )
      )
        throw fail(
          409,
          "Supervisor coverage overlaps; release previous coverage first",
        );
      const assigned = (
        await tx.execute(
          sql`SELECT r.room_id FROM housekeeping_room_assignments r JOIN housekeeping_attendant_assignments a USING(tenant_id,property_id,business_date,shift_id,attendant_id) WHERE r.tenant_id=${u.tenantId} AND r.property_id=${b.propertyId} AND r.business_date=${b.date} AND r.shift_id=${b.shiftId} AND r.active AND a.supervisor_id=${b.supervisorId}`,
        )
      ).rows as Row[];
      if (assigned.some((r) => !coverage.includes(r.room_id)))
        throw fail(
          409,
          "Coverage must contain all assigned team rooms; move or release attendants first",
        );
      await tx.execute(
        sql`INSERT INTO housekeeping_supervisor_assignments VALUES (${u.tenantId},${b.propertyId},${b.date},${b.shiftId},${b.supervisorId},${JSON.stringify([...new Set(b.floors)])}::jsonb,${JSON.stringify([...new Set(b.rooms)])}::jsonb,${JSON.stringify(coverage)}::jsonb) ON CONFLICT(tenant_id,property_id,business_date,shift_id,supervisor_id) DO UPDATE SET floors=excluded.floors,rooms=excluded.rooms,coverage=excluded.coverage`,
      );
      await changed(tx, u, b.propertyId, "supervisor", b.supervisorId);
      return { ok: true, coverage };
    });
  });
  app.put("/api/local-housekeeping/attendants", async (req) => {
    const b = scopeSchema
      .extend({
        attendantId: id,
        supervisorId: id,
        floors: list,
        sections: list,
        rooms: list,
      })
      .parse(req.body);
    const u = req.principal;
    return locked(u, b.propertyId, async (tx) => {
      const a = await access(tx, u, b.propertyId);
      if (
        !a.manager &&
        !(
          a.self?.job_role === "supervisor" &&
          a.self.can_manage &&
          b.supervisorId === u.id
        )
      )
        throw fail(403, "Authorized supervisor or manager required");
      const previous = (
        await tx.execute(
          sql`SELECT supervisor_id FROM housekeeping_attendant_assignments WHERE ${where(u, b)} AND attendant_id=${b.attendantId}`,
        )
      ).rows[0] as Row | undefined;
      if (!a.manager && previous && previous.supervisor_id !== u.id)
        throw fail(403, "Cannot move another supervisor's attendant");
      const spv = (
        await tx.execute(
          sql`SELECT coverage FROM housekeeping_supervisor_assignments WHERE ${where(u, b)} AND supervisor_id=${b.supervisorId}`,
        )
      ).rows[0] as Row | undefined;
      if (!spv) throw fail(409, "Supervisor coverage required");
      const dir = await directory(tx, u, b.propertyId);
      const selected = resolve(dir, b.floors, b.rooms, b.sections);
      const releasing =
        selected.length === 0 && previous?.supervisor_id === b.supervisorId;
      if (!releasing) {
        await scheduled(tx, u, b, b.attendantId, "attendant");
        await scheduled(tx, u, b, b.supervisorId, "supervisor");
      }
      if (selected.some((r) => !spv.coverage.includes(r)))
        throw fail(409, "Room is outside supervisor coverage");
      const conflict = (
        await tx.execute(
          sql`SELECT room_id FROM housekeeping_room_assignments WHERE ${where(u, b)} AND active AND attendant_id!=${b.attendantId}`,
        )
      ).rows as Row[];
      if (conflict.some((r) => selected.includes(r.room_id)))
        throw fail(409, "Room already has an active attendant in this shift");
      await tx.execute(
        sql`INSERT INTO housekeeping_attendant_assignments VALUES (${u.tenantId},${b.propertyId},${b.date},${b.shiftId},${b.attendantId},${b.supervisorId},${JSON.stringify(b.floors)}::jsonb,${JSON.stringify(b.sections)}::jsonb,${JSON.stringify(b.rooms)}::jsonb) ON CONFLICT(tenant_id,property_id,business_date,shift_id,attendant_id) DO UPDATE SET supervisor_id=excluded.supervisor_id,floors=excluded.floors,sections=excluded.sections,rooms=excluded.rooms,worksheet_active=true`,
      );
      const old = (
        await tx.execute(
          sql`SELECT id,room_id FROM housekeeping_room_assignments WHERE ${where(u, b)} AND attendant_id=${b.attendantId} AND active`,
        )
      ).rows as Row[];
      for (const r of old.filter((r) => !selected.includes(r.room_id)))
        await tx.execute(
          sql`UPDATE housekeeping_room_assignments SET active=false,local_status='released',updated_at=now() WHERE id=${r.id}`,
        );
      for (const room of selected.filter(
        (r) => !old.some((o) => o.room_id === r),
      )) {
        const r = dir.find((r) => r.room_id === room)!;
        await tx.execute(
          sql`INSERT INTO housekeeping_room_assignments(id,tenant_id,property_id,business_date,shift_id,attendant_id,room_id,baseline_status,baseline_attention,baseline_at) VALUES (${randomUUID()},${u.tenantId},${b.propertyId},${b.date},${b.shiftId},${b.attendantId},${room},${r.status},${r.attention},${r.updated_at})`,
        );
      }
      await changed(tx, u, b.propertyId, "attendant", b.attendantId);
      return { ok: true, rooms: selected };
    });
  });
  app.patch("/api/local-housekeeping/progress/:id", async (req) => {
    const b = scopeSchema
      .extend({ status: z.enum(["assigned", "in_progress", "completed"]) })
      .parse(req.body);
    const rid = id.parse((req.params as Row).id),
      u = req.principal;
    return locked(u, b.propertyId, async (tx) => {
      const a = await access(tx, u, b.propertyId);
      const room = (
        await tx.execute(
          sql`SELECT r.*,a.supervisor_id FROM housekeeping_room_assignments r JOIN housekeeping_attendant_assignments a USING(tenant_id,property_id,business_date,shift_id,attendant_id) WHERE r.tenant_id=${u.tenantId} AND r.property_id=${b.propertyId} AND r.business_date=${b.date} AND r.shift_id=${b.shiftId} AND r.id=${rid} AND r.active`,
        )
      ).rows[0] as Row | undefined;
      if (!room) throw fail(404, "Assignment not found");
      if (
        !a.manager &&
        !(
          a.self?.job_role === "supervisor" &&
          a.self.can_manage &&
          room.supervisor_id === u.id
        )
      )
        throw fail(
          403,
          "Local progress requires manager or authorized supervisor",
        );
      await tx.execute(
        sql`UPDATE housekeeping_room_assignments SET local_status=${b.status},updated_at=now() WHERE id=${rid}`,
      );
      await changed(tx, u, b.propertyId, "progress", rid);
      return { ok: true };
    });
  });

  app.get("/api/local-housekeeping/board", async (req) => {
    const s = scopeSchema.parse(req.query),
      u = req.principal;
    // A repeatable snapshot keeps all workload figures internally consistent.
    return db.orm.transaction(
      async (tx) => {
        const a = await access(tx, u, s.propertyId);
        if (
          !(
            await tx.execute(
              sql`SELECT 1 FROM housekeeping_shifts WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND id=${s.shiftId}`,
            )
          ).rows.length
        )
          throw fail(404, "Shift not found");
        const allSup = (
          await tx.execute(
            sql`SELECT * FROM housekeeping_supervisor_assignments WHERE ${where(u, s)} ORDER BY supervisor_id`,
          )
        ).rows as Row[];
        const allAtt = (
          await tx.execute(
            sql`SELECT * FROM housekeeping_attendant_assignments WHERE ${where(u, s)} AND worksheet_active ORDER BY attendant_id`,
          )
        ).rows as Row[];
        const supervisors = allSup.filter(
          (r) =>
            a.manager ||
            r.supervisor_id === u.id ||
            allAtt.some(
              (t) =>
                t.attendant_id === u.id && t.supervisor_id === r.supervisor_id,
            ),
        );
        const attendants = allAtt.filter(
          (r) =>
            a.manager ||
            (a.self?.job_role === "supervisor"
              ? r.supervisor_id === u.id
              : r.attendant_id === u.id),
        );
        const assignments = (
          (
            await tx.execute(
              sql`SELECT * FROM housekeeping_room_assignments WHERE ${where(u, s)} AND active ORDER BY room_id`,
            )
          ).rows as Row[]
        ).filter((r) =>
          attendants.some((t) => t.attendant_id === r.attendant_id),
        );
        const dir = await directory(tx, u, s.propertyId);
        const stays = (
          await tx.execute(
            sql`SELECT room, bool_or(departure=${s.date}::date) AS departure, bool_or(arrival<=${s.date}::date AND departure>${s.date}::date AND status IN ('InHouse','DueOut')) AS stayover FROM reservations WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND status NOT IN ('Cancelled','NoShow') AND room IS NOT NULL GROUP BY room`,
          )
        ).rows as Row[];
        const visibleIds = a.manager
          ? dir.map((r) => r.room_id)
          : a.self?.job_role === "supervisor"
            ? supervisors.flatMap((r) => r.coverage)
            : assignments.map((r) => r.room_id);
        const rooms = dir
          .filter((r) => visibleIds.includes(r.room_id))
          .map((r) => {
            const stay = stays.find((t) => t.room === r.room_id);
            const kind = stay?.departure
              ? "departure"
              : stay?.stayover
                ? "stayover"
                : "other";
            const assignment = assignments.find((t) => t.room_id === r.room_id);
            return {
              ...r,
              room_id: String(r.room_id),
              floor: String(r.floor),
              status: String(r.status),
              updated_at: r.updated_at,
              kind,
              credits: Number(r[kind + "_credits"]),
              assignment: assignment || null,
              snapshotChanged: assignment
                ? assignment.baseline_status !== r.status ||
                  assignment.baseline_attention !== r.attention
                : null,
              discrepancy:
                !!r.attention ||
                !["dirty", "clean", "inspected"].includes(
                  String(r.status).toLowerCase(),
                ),
            };
          });
        const workload = (ids: string[]) => {
          const items = rooms.filter((r) => ids.includes(r.room_id));
          return {
            rooms: items.length,
            departure: items.filter((r) => r.kind === "departure").length,
            stayover: items.filter((r) => r.kind === "stayover").length,
            credits:
              Math.round(items.reduce((sum, r) => sum + r.credits, 0) * 100) /
              100,
            dirty: items.filter(
              (r) => String(r.status).toLowerCase() === "dirty",
            ).length,
            clean: items.filter(
              (r) => String(r.status).toLowerCase() === "clean",
            ).length,
            inspected: items.filter(
              (r) => String(r.status).toLowerCase() === "inspected",
            ).length,
            outstanding: items.filter(
              (r) => r.assignment && r.assignment.local_status !== "completed",
            ).length,
            discrepancies: items.filter((r) => r.discrepancy).length,
          };
        };
        const schedules = (
          await tx.execute(
            sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE ${where(u, s)}`,
          )
        ).rows as Row[];
        const name = (uid: string) =>
          a.staff.find((r) => r.user_id === uid)?.name || "Unavailable staff";
        const team = attendants.map((t) => ({
          ...t,
          attendant_id: String(t.attendant_id),
          supervisor_id: String(t.supervisor_id),
          name: name(t.attendant_id),
          eligible:
            a.staff.some(
              (r) => r.user_id === t.attendant_id && r.job_role === "attendant",
            ) &&
            schedules.some((r) => r.user_id === t.attendant_id && r.available),
          workload: workload(
            assignments
              .filter((r) => r.attendant_id === t.attendant_id)
              .map((r) => r.room_id),
          ),
        }));
        const available = a.staff.filter(
          (r) =>
            r.job_role === "attendant" &&
            schedules.some((t) => t.user_id === r.user_id && t.available),
        );
        const unassignedAvailable = available.filter(
          (r) => !assignments.some((t) => t.attendant_id === r.user_id),
        );
        const warningTeams = a.manager
          ? available
          : available.filter((r) =>
              team.some((t) => t.attendant_id === r.user_id),
            );
        const credits = warningTeams.map(
          (r) =>
            team.find((t) => t.attendant_id === r.user_id)?.workload.credits ||
            0,
        );
        const average = credits.length
          ? credits.reduce((x, y) => x + y, 0) / credits.length
          : 0;
        const warnings: string[] = [];
        if (
          credits.length > 1 &&
          average > 0 &&
          Math.max(...credits) > average * 1.5
        )
          warnings.push(
            "Workload imbalance: an attendant exceeds 150% of the available team average.",
          );
        if (
          team.some((t) => !t.eligible) ||
          supervisors.some(
            (t) =>
              !a.staff.some(
                (r) =>
                  r.user_id === t.supervisor_id && r.job_role === "supervisor",
              ) ||
              !schedules.some(
                (r) => r.user_id === t.supervisor_id && r.available,
              ),
          )
        )
          warnings.push(
            "Assigned staff no longer eligible or available. Manager review required.",
          );
        const source = (
          await tx.execute(
            sql`SELECT mode,last_sync,CASE WHEN EXISTS(SELECT 1 FROM ohip_connection_properties m JOIN ohip_connections o ON o.tenant_id=m.tenant_id AND o.id=m.connection_id WHERE m.tenant_id=connections.tenant_id AND m.property_id=connections.property_id AND (m.paused OR o.paused OR o.archived_at IS NOT NULL)) THEN 'PAUSED' ELSE status END AS status FROM connections WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId}`,
          )
        ).rows[0] as Row | undefined;
        const unmapped = a.manager
          ? (
              await tx.execute(
                sql`SELECT r.id FROM rooms r WHERE tenant_id=${u.tenantId} AND property_id=${s.propertyId} AND NOT EXISTS(SELECT 1 FROM housekeeping_room_directory d WHERE d.tenant_id=r.tenant_id AND d.property_id=r.property_id AND d.room_id=r.id) ORDER BY r.id`,
              )
            ).rows
          : [];
        return {
          scope: s,
          manager: a.manager,
          canManage:
            a.manager ||
            (a.self?.job_role === "supervisor" && a.self.can_manage),
          supervisors: supervisors.map((t) => ({
            ...t,
            ...(!a.manager && a.self?.job_role === "attendant"
              ? {
                  coverage: t.coverage.filter((r: string) =>
                    visibleIds.includes(r),
                  ),
                  rooms: t.rooms.filter((r: string) => visibleIds.includes(r)),
                  floors: [...new Set(rooms.map((r) => r.floor))],
                }
              : {}),
            name: name(t.supervisor_id),
            attendants: team.filter((r) => r.supervisor_id === t.supervisor_id),
            workload: workload(
              assignments
                .filter((r) =>
                  attendants.some(
                    (a) =>
                      a.attendant_id === r.attendant_id &&
                      a.supervisor_id === t.supervisor_id,
                  ),
                )
                .map((r) => r.room_id),
            ),
          })),
          attendants: team,
          rooms,
          unassignedRooms: rooms
            .filter((r) => !r.assignment)
            .map((r) => r.room_id),
          unmappedRooms: unmapped,
          unassignedAvailableAttendants: a.manager ? unassignedAvailable : [],
          assignableStaff:
            a.manager ||
            (a.self?.job_role === "supervisor" && a.self.can_manage)
              ? available.filter(
                  (r) =>
                    a.manager ||
                    !allAtt.some(
                      (t) =>
                        t.attendant_id === r.user_id &&
                        t.supervisor_id !== u.id,
                    ),
                )
              : [],
          staff: a.manager
            ? a.staff
            : a.staff.filter(
                (r) =>
                  r.user_id === u.id ||
                  attendants.some((t) => t.attendant_id === r.user_id),
              ),
          schedules: a.manager
            ? schedules
            : schedules.filter(
                (r) =>
                  r.user_id === u.id ||
                  attendants.some((t) => t.attendant_id === r.user_id),
              ),
          workload: workload(assignments.map((r) => r.room_id)),
          warnings,
          source: source?.mode === "demo" ? "DEMO" : "Cached room snapshot",
          lastOhipSync: source?.mode === "real" ? source.last_sync : null,
          connectionStatus: source?.status || "not_connected",
          roomSnapshotAt: rooms.length
            ? rooms
                .filter((r) => r.updated_at)
                .map((r) => new Date(r.updated_at).toISOString())
                .sort()
                .at(-1) || null
            : null,
          snapshotNotice:
            "Snapshot changes are observations only. Completion requires an explicit local progress update. Last OHIP sync is the connection sync, not proof of a live room feed.",
        };
      },
      { isolationLevel: "repeatable read" },
    );
  });
}
