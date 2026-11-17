import { afterEach, describe, it, expect } from "vitest";
import { housekeepingFixture } from "./housekeeping-fixture";
import { sql } from "../apps/api/src/db";
let f: Awaited<ReturnType<typeof housekeepingFixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
async function fixture() {
  f = await housekeepingFixture();
  return f;
}
async function command(
  f: Awaited<ReturnType<typeof fixture>>,
  operations: unknown[],
  auth = f.admin,
  extra: Record<string, unknown> = {},
) {
  const sheet = (
    await f.call(
      "worksheet?" + new URLSearchParams(f.scope()),
      undefined,
      f.admin,
    )
  ).json();
  return f.call(
    "worksheet",
    {
      ...f.scope(),
      baseRevision: sheet.revision,
      mutationId: crypto.randomUUID(),
      operations,
      ...extra,
    },
    auth,
  );
}
describe("inline shift scheduling uses the existing atomic worksheet transaction", () => {
  it("adds only the selected eligible supervisor and assigns floors once, including idempotent replay", async () => {
    const f = await fixture(),
      mutationId = crypto.randomUUID();
    const before = (
      await f.call("worksheet?" + new URLSearchParams(f.scope()))
    ).json();
    const operations = [
      { type: "schedule", userIds: [f.s1.id] },
      {
        type: "floors",
        floorIds: ["West", "East"],
        supervisorId: f.s1.id,
        replace: true,
      },
    ];
    const body = { mutationId, baseRevision: before.revision };
    const result = await command(f, operations, f.admin, body);
    expect(result.statusCode, result.body).toBe(200);
    const rows = await f.db.query(
      sql`SELECT user_id,available FROM housekeeping_staff_schedules WHERE business_date=${f.scope().date} AND shift_id='AM'`,
    );
    expect(rows).toEqual([{ user_id: f.s1.id, available: true }]);
    const sheet = (
      await f.call("worksheet?" + new URLSearchParams(f.scope()))
    ).json();
    expect(sheet.supervisorFloors[f.s1.id].sort()).toEqual(["East", "West"]);
    expect((await command(f, operations, f.admin, body)).json()).toMatchObject({
      replayed: true,
      revision: result.json().revision,
    });
    const change = (
      await f.db.query(
        sql`SELECT before_plan,after_plan FROM housekeeping_worksheet_changes WHERE id=${result.json().changeId}`,
      )
    )[0];
    expect(change.before_plan.schedules).toEqual([
      { user_id: f.s1.id, available: null },
    ]);
    expect(change.after_plan.schedules).toEqual([
      { user_id: f.s1.id, available: true },
    ]);
  });
  it("rolls back presence and assignment together on a failed assignment", async () => {
    const f = await fixture();
    const result = await command(f, [
      { type: "schedule", userIds: [f.s1.id] },
      {
        type: "floors",
        floorIds: ["unverified"],
        supervisorId: f.s1.id,
        replace: true,
      },
    ]);
    expect(result.statusCode).toBe(409);
    expect(
      await f.db.query(sql`SELECT * FROM housekeeping_staff_schedules`),
    ).toEqual([]);
    expect(
      await f.db.query(sql`SELECT * FROM housekeeping_supervisor_assignments`),
    ).toEqual([]);
    expect(
      await f.db.query(sql`SELECT * FROM housekeeping_worksheet_changes`),
    ).toEqual([]);
  });
  it("saves and undoes scheduling, team and room assignments as one operation without deleting history", async () => {
    const f = await fixture();
    const result = await command(f, [
      { type: "schedule", userIds: [f.s1.id, f.a1.id] },
      {
        type: "floors",
        floorIds: ["West"],
        supervisorId: f.s1.id,
        replace: true,
      },
      { type: "team", attendantId: f.a1.id, supervisorId: f.s1.id },
      { type: "rooms", roomIds: ["201", "202"], attendantId: f.a1.id },
    ]);
    expect(result.statusCode, result.body).toBe(200);
    expect(
      (
        await f.db.query(
          sql`SELECT room_id FROM housekeeping_room_assignments WHERE active`,
        )
      ).length,
    ).toBe(2);
    const undone = await f.call(
      "worksheet/undo",
      {
        ...f.scope(),
        mutationId: crypto.randomUUID(),
        baseRevision: result.json().revision,
        changeId: result.json().changeId,
      },
      f.admin,
      "POST",
    );
    expect(undone.statusCode, undone.body).toBe(200);
    expect(
      await f.db.query(
        sql`SELECT room_id FROM housekeeping_room_assignments WHERE active`,
      ),
    ).toEqual([]);
    expect(
      await f.db.query(
        sql`SELECT user_id FROM housekeeping_staff_schedules WHERE available`,
      ),
    ).toEqual([]);
    expect(
      (await f.db.query(sql`SELECT room_id FROM housekeeping_room_assignments`))
        .length,
    ).toBe(2);
    const undoAudit = (
      await f.db.query(
        sql`SELECT before_plan,after_plan FROM housekeeping_worksheet_changes WHERE id=${undone.json().changeId}`,
      )
    )[0];
    expect(
      undoAudit.before_plan.schedules.every(
        (row: { available: boolean }) => row.available,
      ),
    ).toBe(true);
    expect(
      undoAudit.after_plan.schedules.every(
        (row: { available: boolean }) => !row.available,
      ),
    ).toBe(true);
  });
  it("rejects supervisor self-scheduling, inactive users, wrong roles and property access", async () => {
    const f = await fixture();
    expect(
      (await command(f, [{ type: "schedule", userIds: [f.a1.id] }], f.s1))
        .statusCode,
    ).toBe(403);
    for (const auth of [f.other, f.front, f.noProperty])
      expect(
        (await command(f, [{ type: "schedule", userIds: [f.a1.id] }], auth))
          .statusCode,
      ).toBe(403);
    for (const id of [f.front.id, f.noProperty.id])
      expect(
        (await command(f, [{ type: "schedule", userIds: [id] }])).statusCode,
      ).toBe(403);
    await f.db.query(
      sql`INSERT INTO local_archives VALUES ('demo','users',${f.a1.id},now())`,
    );
    expect(
      (await command(f, [{ type: "schedule", userIds: [f.a1.id] }])).statusCode,
    ).toBe(403);
    expect(
      await f.db.query(sql`SELECT * FROM housekeeping_staff_schedules`),
    ).toEqual([]);
  });
  it("checks shift and revision before scheduling and permits only one concurrent winner", async () => {
    const f = await fixture();
    expect(
      (
        await command(f, [{ type: "schedule", userIds: [f.s1.id] }], f.admin, {
          baseRevision: "999999",
        })
      ).statusCode,
    ).toBe(409);
    const sheet = (
      await f.call("worksheet?" + new URLSearchParams(f.scope()))
    ).json();
    const results = await Promise.all(
      [f.s1, f.s2].map((s) =>
        command(
          f,
          [
            { type: "schedule", userIds: [s.id] },
            {
              type: "floors",
              floorIds: ["West"],
              supervisorId: s.id,
              replace: true,
            },
          ],
          f.admin,
          { baseRevision: sheet.revision },
        ),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      await f.db.query(
        sql`SELECT user_id FROM housekeeping_staff_schedules WHERE available`,
      ),
    ).toHaveLength(1);
    const invalid = await command(
      f,
      [{ type: "schedule", userIds: [f.a1.id] }],
      f.admin,
      { shiftId: "missing" },
    );
    expect(invalid.statusCode).toBe(404);
    expect(
      await f.db.query(
        sql`SELECT user_id FROM housekeeping_staff_schedules WHERE user_id=${f.a1.id}`,
      ),
    ).toEqual([]);
  });
});
