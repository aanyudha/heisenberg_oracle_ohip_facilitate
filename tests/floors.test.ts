import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { housekeepingFixture } from "./housekeeping-fixture";
import { sql } from "../apps/api/src/db";
import type { WorksheetOperation } from "@hospitality/contracts";
let f: Awaited<ReturnType<typeof housekeepingFixture>>;
const day = "2026-11-13";
beforeAll(async () => {
  f = await housekeepingFixture();
}, 60000);
afterAll(async () => {
  await f?.close();
});
async function sheet(date = day, auth = f.admin, shiftId = "AM") {
  const r = await f.call(
    "worksheet?" + new URLSearchParams(f.scope(date, shiftId)),
    undefined,
    auth,
  );
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function change(
  ops: WorksheetOperation[],
  auth = f.admin,
  date = day,
  revision?: string,
) {
  return f.call(
    "worksheet",
    {
      ...f.scope(date),
      baseRevision: revision || (await sheet(date, auth)).revision,
      mutationId: randomUUID(),
      operations: ops,
    },
    auth,
  );
}
async function ok(ops: WorksheetOperation[], auth = f.admin, date = day) {
  const r = await change(ops, auth, date);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const floor = (
  floorIds: string[],
  supervisorId: string | null,
  replace = false,
): WorksheetOperation => ({ type: "floors", floorIds, supervisorId, replace });
describe("Floor → Supervisor → Attendant", () => {
  it("reuses migration 0004/0005 tables and assigns several primary floors without daily setup", async () => {
    await ok([floor(["West", "East"], f.s1.id), floor(["Annex"], f.s2.id)]);
    const manager = await sheet();
    expect(manager.supervisorFloors[f.s1.id]).toEqual(["East", "West"]);
    expect(
      manager.floorAssignments.find((r: any) => r.id === "West"),
    ).toMatchObject({
      supervisorId: f.s1.id,
      totalRooms: 2,
      assignedRooms: 0,
      unassignedRooms: 2,
    });
    expect(
      (
        await f.db.query(
          sql`SELECT version FROM schema_migrations ORDER BY version`,
        )
      ).map((r) => r.version),
    ).toEqual(["0001", "0002", "0003", "0004", "0005"]);
    expect(
      (
        await f.db.query(
          sql`SELECT floors FROM housekeeping_supervisor_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${day} AND supervisor_id=${f.s1.id}`,
        )
      )[0].floors,
    ).toEqual(["East", "West"]);
  });
  it("rejects duplicate primaries and rolls back the entire duplicate batch", async () => {
    expect((await change([floor(["West"], f.s2.id)])).statusCode).toBe(409);
    const date = "2026-11-14";
    expect(
      (
        await change(
          [floor(["West"], f.s1.id), floor(["West"], f.s2.id)],
          f.admin,
          date,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await sheet(date)).floorAssignments.find((r: any) => r.id === "West")
        .supervisorId,
    ).toBeNull();
  });
  it("automatically scopes a supervisor to own floors and lets them select available registered attendants", async () => {
    const own = await sheet(day, f.s1);
    expect(own.canManage).toBe(true);
    expect(own.supervisorFloors[f.s1.id]).toEqual(["East", "West"]);
    expect(own.rooms.map((r: any) => r.id)).toEqual([
      "201",
      "202",
      "203",
      "204",
    ]);
    expect(own.attendants.some((r: any) => r.id === f.a1.id && r.active)).toBe(
      true,
    );
    await ok(
      [
        { type: "team", attendantId: f.a1.id, supervisorId: f.s1.id },
        { type: "rooms", roomIds: ["201", "202"], attendantId: f.a1.id },
      ],
      f.s1,
    );
    const mine = await sheet(day, f.a1);
    expect(mine.rooms.map((r: any) => r.id)).toEqual(["201", "202"]);
    expect(mine.canManage).toBe(false);
  });
  it("blocks cross-floor moves, floor grants, wrong staff and other supervisor teams at the API", async () => {
    expect(
      (
        await change(
          [{ type: "rooms", roomIds: ["205"], attendantId: f.a1.id }],
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await change([floor(["Annex"], f.s1.id, true)], f.s1)).statusCode,
    ).toBe(403);
    expect(
      (
        await change(
          [{ type: "coverage", roomIds: ["205"], supervisorId: f.s1.id }],
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
    await ok(
      [{ type: "team", attendantId: f.a2.id, supervisorId: f.s2.id }],
      f.s2,
    );
    expect(
      (
        await change(
          [{ type: "team", attendantId: f.a2.id, supervisorId: f.s1.id }],
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await change(
          [
            {
              type: "team",
              attendantId: f.noProperty.id,
              supervisorId: f.s1.id,
            },
          ],
          f.s1,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await change(
          [{ type: "rooms", roomIds: ["203"], attendantId: f.a1.id }],
          f.a1,
        )
      ).statusCode,
    ).toBe(403);
  });
  it("supports explicit room exceptions and restores primary coverage when an unused exception is cleared", async () => {
    await ok([{ type: "coverage", roomIds: ["203"], supervisorId: f.s2.id }]);
    expect((await sheet(day, f.s1)).rooms.map((r: any) => r.id)).not.toContain(
      "203",
    );
    expect((await sheet(day, f.s2)).rooms.map((r: any) => r.id)).toContain(
      "203",
    );
    await ok([{ type: "coverage", roomIds: ["203"], supervisorId: null }]);
    expect((await sheet()).roomSupervisors["203"]).toBe(f.s1.id);
  });
  it("preserves attendant work and progress as visible exceptions when the manager replaces a floor supervisor", async () => {
    const before = await f.db.query(
      sql`SELECT id,room_id,attendant_id,local_status FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${day} AND active ORDER BY room_id`,
    );
    await ok([floor(["West"], f.s2.id, true)]);
    const manager = await sheet();
    expect(
      manager.floorAssignments.find((r: any) => r.id === "West"),
    ).toMatchObject({
      supervisorId: f.s2.id,
      assignedRooms: 2,
      exceptionRooms: 2,
    });
    expect(manager.roomExceptions).toMatchObject({
      "201": f.s1.id,
      "202": f.s1.id,
    });
    expect(
      await f.db.query(
        sql`SELECT id,room_id,attendant_id,local_status FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${day} AND active ORDER BY room_id`,
      ),
    ).toEqual(before);
    expect((await sheet(day, f.s1)).rooms.map((r: any) => r.id)).toContain(
      "201",
    );
    expect((await sheet(day, f.s2)).rooms.map((r: any) => r.id)).not.toContain(
      "201",
    );
    expect(
      (
        await change([
          { type: "coverage", roomIds: ["201"], supervisorId: null },
        ])
      ).statusCode,
    ).toBe(409);
    await ok([{ type: "team", attendantId: f.a1.id, supervisorId: f.s2.id }]);
    const moved = await sheet();
    expect(moved.assignments["201"]).toBe(f.a1.id);
    expect(moved.roomExceptions["201"]).toBeUndefined();
    expect(moved.supervisorFloors[f.s1.id]).toEqual(["East"]);
    expect(moved.supervisorFloors[f.s2.id]).toEqual(["Annex", "West"]);
  });
  it("recalculates floor/attendant workload during batch moves and retains primary floor metadata", async () => {
    await ok(
      [{ type: "rooms", roomIds: ["201", "202"], attendantId: f.a2.id }],
      f.s2,
    );
    const s = await sheet();
    const west = s.floorAssignments.find((r: any) => r.id === "West");
    expect(west.assignedRooms).toBe(2);
    expect(west.unassignedRooms).toBe(0);
    expect(west.credits).toBe(
      s.rooms
        .filter((r: any) => r.floor === "West")
        .reduce((n: number, r: any) => n + (r.credits || 0), 0),
    );
    expect(s.supervisorFloors[f.s2.id]).toContain("West");
    expect(
      await f.db.query(
        sql`SELECT room_id FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${day} AND active AND room_id IN ('201','202')`,
      ),
    ).toHaveLength(2);
  });
  it("undoes floor replacement and supervisor room reassignment while retaining history", async () => {
    const date = "2026-11-15";
    await ok([floor(["West", "East"], f.s1.id)], f.admin, date);
    const replaced = await ok([floor(["West"], f.s2.id, true)], f.admin, date);
    let r = await f.call(
      "worksheet/undo",
      {
        ...f.scope(date),
        baseRevision: replaced.revision,
        changeId: replaced.changeId,
        mutationId: randomUUID(),
      },
      f.admin,
      "POST",
    );
    expect(r.statusCode, r.body).toBe(200);
    expect((await sheet(date)).supervisorFloors[f.s1.id]).toEqual([
      "East",
      "West",
    ]);
    await ok(
      [
        { type: "team", attendantId: f.a3.id, supervisorId: f.s1.id },
        { type: "rooms", roomIds: ["201", "202"], attendantId: f.a3.id },
      ],
      f.s1,
      date,
    );
    const release = await ok(
      [{ type: "rooms", roomIds: ["201"], attendantId: null }],
      f.s1,
      date,
    );
    r = await f.call(
      "worksheet/undo",
      {
        ...f.scope(date),
        baseRevision: release.revision,
        changeId: release.changeId,
        mutationId: randomUUID(),
      },
      f.s1,
      "POST",
    );
    expect(r.statusCode, r.body).toBe(200);
    expect((await sheet(date, f.a3)).rooms.map((r: any) => r.id)).toEqual([
      "201",
      "202",
    ]);
    expect(
      await f.db.query(
        sql`SELECT id FROM housekeeping_worksheet_changes WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${date} AND undo_of IS NOT NULL`,
      ),
    ).toHaveLength(2);
  });
  it("isolates floors by tenant, property, date and shift, without floor inference", async () => {
    expect((await sheet(day, f.s1, "PM")).rooms).toEqual([]);
    expect((await sheet("2026-11-16", f.s1)).rooms).toEqual([]);
    expect(
      (
        await f.call(
          "worksheet?" + new URLSearchParams(f.scope(day)),
          undefined,
          f.other,
        )
      ).statusCode,
    ).toBe(403);
    expect((await change([floor(["2"], f.s1.id)])).statusCode).toBe(409);
    expect(
      (await change([floor(["West"], f.noProperty.id, true)])).statusCode,
    ).toBe(409);
  });
  it("serializes competing floor owners with optimistic conflict checks and still blocks Oracle mutation APIs", async () => {
    const date = "2026-11-17",
      revision = (await sheet(date)).revision;
    const result = await Promise.all([
      change([floor(["West"], f.s1.id)], f.admin, date, revision),
      change([floor(["West"], f.s2.id)], f.admin, date, revision),
    ]);
    expect(result.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
      expect(
        (
          await f.app.inject({
            method,
            url: "/api/hsk/hotels/TEST/taskSheets",
            headers: { cookie: f.admin.cookie, "x-csrf-token": f.admin.csrf },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
  });
});
