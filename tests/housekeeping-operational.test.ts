import { beforeAll, afterAll, it, expect } from "vitest";
import { operationalFixture } from "./housekeeping-operational-fixture";
import { sql } from "../apps/api/src/db";
import { distributeRooms } from "@hospitality/contracts";
let f: Awaited<ReturnType<typeof operationalFixture>>;
beforeAll(async () => {
  f = await operationalFixture();
  const r = await f.command([
    ...["Garden", "Tower", "Annex"].map((floor, i) => ({
      type: "floors",
      floorIds: [floor],
      supervisorId: f.supervisors[i].id,
    })),
    ...f.attendants.map((a, i) => ({
      type: "team",
      attendantId: a.id,
      supervisorId: f.supervisors[Math.floor(i / 4)].id,
    })),
  ]);
  expect(r.statusCode, r.body).toBe(200);
}, 60000);
afterAll(async () => {
  await f?.close();
});
it("uses 120 actual fixture snapshots, 3 supervisors, 12 registered rostered attendants and two scoped shifts", async () => {
  const s = await f.worksheet();
  expect(s.rooms).toHaveLength(120);
  expect(s.supervisors).toHaveLength(3);
  expect(s.attendants).toHaveLength(12);
  expect(s.rosterConfigured).toBe(true);
  expect(s.rooms.some((r: any) => r.departure)).toBe(true);
  expect(s.rooms.some((r: any) => r.stayover)).toBe(true);
  const pm = await f.worksheet(f.admin, "PM");
  expect(pm.assignments).toEqual({});
  expect(pm.rosterConfigured).toBe(false);
  expect(pm.attendants.every((a: any) => !a.available)).toBe(true);
});
it("rejects unrostered staff without creating attendance or silently assigning", async () => {
  const s = f.scope("2026-11-12", "PM"),
    before = await f.worksheet(f.admin, "PM");
  const r = await f.call("worksheet", {
    ...s,
    baseRevision: before.revision,
    mutationId: crypto.randomUUID(),
    operations: [{ type: "team", attendantId: f.a1.id, supervisorId: f.s1.id }],
  });
  expect(r.statusCode).toBe(409);
  expect((await f.worksheet(f.admin, "PM")).assignments).toEqual({});
});
it("distributes 40 rooms to four attendants with shared deterministic Balanced Credits, one audit and whole-batch undo", async () => {
  const before = await f.worksheet(f.s1),
    ids = before.rooms.map((r: any) => r.id),
    targets = f.attendants.slice(0, 4).map((a) => a.id);
  const plan = distributeRooms(before, ids, targets, "credits");
  const result = await f.command(
    [
      {
        type: "distribute",
        roomIds: ids,
        attendantIds: targets,
        mode: "credits",
      },
    ],
    f.s1,
  );
  expect(result.statusCode, result.body).toBe(200);
  const after = await f.worksheet(f.s1);
  expect(Object.keys(after.assignments)).toHaveLength(40);
  for (const row of plan.rows)
    expect(
      row.roomIds.every((id) => after.assignments[id] === row.attendantId),
    ).toBe(true);
  const events = await f.db.query(
    sql`SELECT count(*) AS count FROM audit_logs WHERE tenant_id='demo' AND action='housekeeping.worksheet.move' AND target=${result.json().changeId}`,
  );
  expect(Number(events[0].count)).toBe(1);
  const undo = await f.call(
    "worksheet/undo",
    {
      ...f.scope(),
      baseRevision: after.revision,
      mutationId: crypto.randomUUID(),
      changeId: result.json().changeId,
    },
    f.s1,
    "POST",
  );
  expect(undo.statusCode, undo.body).toBe(200);
  expect((await f.worksheet(f.s1)).assignments).toEqual({});
  expect(
    (
      await f.command(
        [
          {
            type: "distribute",
            roomIds: ids,
            attendantIds: targets,
            mode: "credits",
          },
        ],
        f.s1,
      )
    ).statusCode,
  ).toBe(200);
});
it("handles 20-to-one and 10-room reassignment as atomic commands and blocks cross-floor/other team targets", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => String(1041 + i));
  expect(
    (
      await f.command(
        [
          {
            type: "distribute",
            roomIds: ids,
            attendantIds: [f.attendants[4].id],
            mode: "equal",
          },
        ],
        f.s2,
      )
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await f.command(
        [
          {
            type: "distribute",
            roomIds: ids.slice(0, 10),
            attendantIds: [f.attendants[5].id],
            mode: "equal",
          },
        ],
        f.s2,
      )
    ).statusCode,
  ).toBe(200);
  const s = await f.worksheet(f.s2);
  expect(
    Object.values(s.assignments).filter((id) => id === f.attendants[5].id),
  ).toHaveLength(10);
  expect(
    (
      await f.command(
        [
          {
            type: "distribute",
            roomIds: ["1001", "1041"],
            attendantIds: [f.a1.id],
            mode: "equal",
          },
        ],
        f.s1,
      )
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.command(
        [
          {
            type: "distribute",
            roomIds: ["1001"],
            attendantIds: [f.attendants[4].id],
            mode: "equal",
          },
        ],
        f.s1,
      )
    ).statusCode,
  ).toBe(403);
});
it("rolls back every room on invalid targets and concurrent supervisor revisions", async () => {
  const s = await f.worksheet(f.s1),
    before = { ...s.assignments };
  expect(
    (
      await f.command(
        [
          {
            type: "distribute",
            roomIds: ["1001", "1002"],
            attendantIds: [f.a1.id, f.noProperty.id],
            mode: "credits",
          },
        ],
        f.s1,
      )
    ).statusCode,
  ).toBe(409);
  expect((await f.worksheet(f.s1)).assignments).toEqual(before);
  const r = await f.command(
    [
      {
        type: "distribute",
        roomIds: ["1001"],
        attendantIds: [f.a2.id],
        mode: "equal",
      },
    ],
    f.s1,
    s.revision,
  );
  expect(r.statusCode).toBe(200);
  expect(
    (
      await f.command(
        [
          {
            type: "distribute",
            roomIds: ["1002"],
            attendantIds: [f.a1.id],
            mode: "equal",
          },
        ],
        f.s1,
        s.revision,
      )
    ).statusCode,
  ).toBe(409);
});
it("reports roster conflicts without deleting assignments or historical records", async () => {
  const before = await f.worksheet();
  const r = await f.call("roster", {
    ...f.scope(),
    userIds: [
      ...f.supervisors,
      ...f.attendants.filter((a) => a.id !== f.a1.id),
    ].map((a) => a.id),
  });
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatch(/reassign|release/i);
  expect((await f.worksheet()).assignments).toEqual(before.assignments);
});
it("reconciles canonical print room counts and credits against saved database assignments and rejects stale revisions", async () => {
  const s = await f.worksheet();
  const r = await f.call(
    "worksheet/print?" +
      new URLSearchParams({ ...f.scope(), revision: s.revision }),
  );
  expect(r.statusCode, r.body).toBe(200);
  const db = await f.db.query(
    sql`SELECT a.attendant_id,count(*) AS count,sum(d.other_credits) AS credits FROM housekeeping_room_assignments a JOIN housekeeping_room_directory d USING(tenant_id,property_id,room_id) WHERE a.tenant_id='demo' AND a.property_id='demo-1' AND a.business_date='2026-11-12' AND a.shift_id='AM' AND a.active GROUP BY a.attendant_id`,
  );
  for (const row of db) {
    const out = r
      .json()
      .reconciliation.attendants.find((a: any) => a.id === row.attendant_id);
    expect(out.rooms).toBe(Number(row.count));
    expect(out.credits).toBe(Number(row.credits));
  }
  expect(r.json().reconciliation.assignedRooms).toBe(60);
  expect(
    (
      await f.call(
        "worksheet/print?" +
          new URLSearchParams({ ...f.scope(), revision: "0" }),
      )
    ).statusCode,
  ).toBe(409);
  const other = await f.call(
    "worksheet/print?" +
      new URLSearchParams({ ...f.scope(), revision: s.revision }),
    undefined,
    f.other,
  );
  expect(other.statusCode).toBe(403);
});
it("uses Equal Rooms explicitly when credits are incomplete and includes existing loads", async () => {
  const s = await f.worksheet();
  s.rooms[0].credits = null;
  const ids = s.rooms.slice(0, 20).map((r: any) => r.id),
    targets = f.attendants.slice(0, 4).map((a) => a.id);
  const plan = distributeRooms(s, ids, targets, "credits");
  expect(plan.fallback).toBe(true);
  expect(plan.effectiveMode).toBe("equal");
  expect(plan.rows.flatMap((r) => r.roomIds)).toHaveLength(20);
  expect(new Set(plan.rows.flatMap((r) => r.roomIds)).size).toBe(20);
  expect(
    distributeRooms(s, [...ids].reverse(), [...targets].reverse(), "credits"),
  ).toEqual(plan);
});
it("configures overnight local shifts, retains property business date and disables new writes to inactive shifts", async () => {
  expect(
    (
      await f.call("shifts", {
        propertyId: "demo-1",
        id: "NIGHT",
        name: "Night",
        startsAt: "22:00",
        endsAt: "06:00",
        active: true,
      })
    ).statusCode,
  ).toBe(200);
  const s = f.scope("2026-11-13", "NIGHT");
  expect(
    (await f.call("roster", { ...s, userIds: [f.s1.id, f.a1.id] })).statusCode,
  ).toBe(200);
  const get = await f.call("worksheet?" + new URLSearchParams(s));
  expect(get.json().scope.date).toBe("2026-11-13");
  expect(get.json().assignments).toEqual({});
  expect(
    (
      await f.call("shifts", {
        propertyId: "demo-1",
        id: "NIGHT",
        name: "Night",
        startsAt: "22:00",
        endsAt: "06:00",
        active: false,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await f.call("roster", { ...s, userIds: [f.a1.id] })).statusCode,
  ).toBe(409);
});
it("updates HK classification only through authorized User Management over the same registered identity", async () => {
  const headers = { cookie: f.admin.cookie, "x-csrf-token": f.admin.csrf };
  const created = await f.app.inject({
    method: "POST",
    url: "/api/admin/users",
    remoteAddress: "127.8.2.2",
    headers,
    payload: {
      name: "Role Editor",
      email: "role-editor@ops.test",
      password: "Isolated-HK-test-password!",
      role: "housekeeping",
      hkRole: "supervisor",
      properties: ["demo-1"],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const uid = created.json().id;
  expect((await f.worksheet()).supervisors.some((s: any) => s.id === uid)).toBe(
    true,
  );
  const update = await f.app.inject({
    method: "PATCH",
    url: "/api/admin/users/" + uid,
    remoteAddress: "127.8.2.3",
    headers,
    payload: {
      role: "housekeeping",
      hkRole: "attendant",
      properties: ["demo-1"],
    },
  });
  expect(update.statusCode, update.body).toBe(200);
  const sheet = await f.worksheet();
  expect(sheet.supervisors.some((s: any) => s.id === uid)).toBe(false);
  expect(sheet.attendants.find((s: any) => s.id === uid).available).toBe(false);
  const invalid = await f.app.inject({
    method: "PATCH",
    url: "/api/admin/users/" + uid,
    remoteAddress: "127.8.2.4",
    headers,
    payload: {
      role: "front_office",
      hkRole: "manager",
      properties: ["demo-1"],
    },
  });
  expect(invalid.statusCode).toBe(400);
});
it("refuses to print when a saved assigned room is absent from the current feed", async () => {
  await f.db.query(
    sql`DELETE FROM rooms WHERE tenant_id='demo' AND property_id='demo-1' AND id='1001'`,
  );
  const s = await f.worksheet();
  expect(s.missingAssignedRooms).toBe(1);
  const r = await f.call(
    "worksheet/print?" +
      new URLSearchParams({ ...f.scope(), revision: s.revision }),
  );
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatch(/reconciliation/);
});
it("closes the legacy housekeeping role setter so classifications cannot bypass User Management", async () => {
  const r = await f.call("staff", {
    propertyId: "demo-1",
    userId: f.a1.id,
    department: "Housekeeping",
    jobRole: "manager",
  });
  expect(r.statusCode).toBe(410);
  expect(r.json().error).toMatch(/Users/);
  expect(
    (await f.call("setup?propertyId=demo-1")).json().canConfigureStaff,
  ).toBe(false);
});
