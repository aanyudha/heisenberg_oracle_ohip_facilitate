import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usabilityFixture } from "./housekeeping-usability-fixture";
import { sql } from "../apps/api/src/db";
let f: Awaited<ReturnType<typeof usabilityFixture>>;
beforeAll(async () => {
  f = await usabilityFixture();
}, 60000);
afterAll(async () => {
  await f?.close();
});
describe("registered Housekeeping staff usability", () => {
  it("explains registered cards excluded from selectors without manufacturing attendance", async () => {
    const sheet = await f.worksheet(f.manager);
    expect(sheet.rooms).toHaveLength(274);
    expect(sheet.supervisors).toHaveLength(2);
    for (const staff of sheet.supervisors)
      expect(staff).toMatchObject({
        active: true,
        available: false,
        eligibilityReason: "not_scheduled",
      });
    expect(sheet.attendants.find((a) => a.id === f.a1.id)).toMatchObject({
      eligibilityReason: "not_scheduled",
    });
    expect(sheet.attendants.find((a) => a.id === f.off.id)).toMatchObject({
      eligibilityReason: "off_shift",
    });
    expect(sheet.warnings.join(" ")).not.toMatch(
      /Credits not configured|Some assigned staff/,
    );
    const roster = (
      await f.call(
        "roster?" + new URLSearchParams(f.scope()),
        undefined,
        f.manager,
      )
    ).json();
    expect(roster.staff.find((s: any) => s.id === f.inactive.id)).toMatchObject(
      { active: false, available: false, eligibilityReason: "inactive" },
    );
    const blocked = await f.command(
      [
        {
          type: "floors",
          floorIds: ["02"],
          supervisorId: f.s1.id,
          replace: true,
        },
      ],
      f.manager,
    );
    expect(blocked.statusCode).toBe(409);
  });
  it("makes explicitly scheduled supervisors selectable and exposes their floors to the assigned supervisor", async () => {
    await f.ok(
      "roster",
      {
        ...f.scope(),
        userIds: [f.s1, f.s2, f.a1, f.a2, f.a3].map((s) => s.id),
      },
      f.manager,
    );
    let sheet = await f.worksheet(f.manager);
    expect(
      sheet.supervisors.every(
        (s) => s.active && s.available && s.eligibilityReason === null,
      ),
    ).toBe(true);
    expect(
      sheet.attendants.find((a) => a.id === f.a1.id)?.assignmentBlockReason,
    ).toBe("supervisor_required");
    const r = await f.command(
      [
        {
          type: "floors",
          floorIds: ["02"],
          supervisorId: f.s1.id,
          replace: true,
        },
      ],
      f.manager,
    );
    expect(r.statusCode, r.body).toBe(200);
    sheet = await f.worksheet(f.s1);
    expect(sheet.supervisorFloors?.[f.s1.id]).toEqual(["02"]);
    expect(sheet.rooms).toHaveLength(100);
    expect(sheet.canManage).toBe(true);
  });
  it("saves 20 rooms to one registered attendant in one transaction", async () => {
    const sheet = await f.worksheet(f.s1),
      ids = sheet.rooms.slice(0, 20).map((r) => r.id);
    const response = await f.command(
      [
        {
          type: "distribute",
          roomIds: ids,
          attendantIds: [f.a1.id],
          mode: "equal",
        },
      ],
      f.s1,
    );
    expect(response.statusCode, response.body).toBe(200);
    const saved = await f.db.query(
      sql`SELECT room_id FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${f.scope().date} AND shift_id='AM' AND attendant_id=${f.a1.id} AND active`,
    );
    expect(saved.map((r) => r.room_id).sort()).toEqual(ids.sort());
  });
  it("redistributes 30 rooms across three attendants with canonical print and no duplicate ownership", async () => {
    const sheet = await f.worksheet(f.s1),
      ids = sheet.rooms.slice(0, 30).map((r) => r.id);
    const response = await f.command(
      [
        {
          type: "distribute",
          roomIds: ids,
          attendantIds: [f.a1.id, f.a2.id, f.a3.id],
          mode: "equal",
        },
      ],
      f.s1,
    );
    expect(response.statusCode, response.body).toBe(200);
    const saved = await f.worksheet(f.s1);
    expect(Object.keys(saved.assignments)).toHaveLength(30);
    for (const a of [f.a1, f.a2, f.a3])
      expect(
        Object.values(saved.assignments).filter((id) => id === a.id),
      ).toHaveLength(10);
    const print = await f.call(
      "worksheet/print?" +
        new URLSearchParams({ ...f.scope(), revision: saved.revision }),
      undefined,
      f.s1,
    );
    expect(print.statusCode, print.body).toBe(200);
    expect(print.json().assignments).toEqual(saved.assignments);
    for (const a of [f.a1, f.a2, f.a3]) {
      const own = await f.worksheet(a);
      expect(own.rooms).toHaveLength(10);
      expect(Object.values(own.assignments).every((id) => id === a.id)).toBe(
        true,
      );
      const report = await f.call(
        "worksheet/print?" +
          new URLSearchParams({ ...f.scope(), revision: own.revision }),
        undefined,
        a,
      );
      expect(report.statusCode, report.body).toBe(200);
      expect(
        report
          .json()
          .rooms.map((r: any) => r.id)
          .sort(),
      ).toEqual(own.rooms.map((r) => r.id).sort());
    }
  });
  it("keeps retained work when a manager changes/removes primary floor ownership", async () => {
    const before = await f.worksheet(f.manager);
    expect(
      (
        await f.command(
          [
            {
              type: "floors",
              floorIds: ["02"],
              supervisorId: f.s2.id,
              replace: true,
            },
          ],
          f.manager,
        )
      ).statusCode,
    ).toBe(200);
    const changed = await f.worksheet(f.manager);
    expect(changed.assignments).toEqual(before.assignments);
    expect(
      changed.floorAssignments?.find((r) => r.id === "02")?.supervisorId,
    ).toBe(f.s2.id);
    expect(
      changed.floorAssignments?.find((r) => r.id === "02")?.exceptionRooms,
    ).toBe(30);
    expect(
      (
        await f.command(
          [
            {
              type: "floors",
              floorIds: ["02"],
              supervisorId: null,
              replace: true,
            },
          ],
          f.manager,
        )
      ).statusCode,
    ).toBe(200);
    expect((await f.worksheet(f.manager)).assignments).toEqual(
      before.assignments,
    );
    expect(
      (
        await f.command(
          [
            {
              type: "floors",
              floorIds: ["02"],
              supervisorId: f.s1.id,
              replace: true,
            },
          ],
          f.manager,
        )
      ).statusCode,
    ).toBe(200);
  });
  it("distinguishes inactive, wrong-role and wrong-property references while retaining assignments", async () => {
    await f.db.query(
      sql`INSERT INTO local_archives(tenant_id,kind,target) VALUES ('demo','users',${f.a1.id})`,
    );
    let sheet = await f.worksheet(f.manager);
    expect(sheet.attendants.find((a) => a.id === f.a1.id)).toMatchObject({
      active: false,
      available: false,
      eligibilityReason: "inactive",
    });
    expect(
      Object.values(sheet.assignments).filter((id) => id === f.a1.id),
    ).toHaveLength(10);
    await f.db.query(
      sql`DELETE FROM local_archives WHERE tenant_id='demo' AND kind='users' AND target=${f.a1.id}`,
    );
    await f.db.query(
      sql`UPDATE memberships SET role='front_office' WHERE tenant_id='demo' AND user_id=${f.a1.id}`,
    );
    sheet = await f.worksheet(f.manager);
    expect(
      sheet.attendants.find((a) => a.id === f.a1.id)?.eligibilityReason,
    ).toBe("wrong_role");
    await f.db.query(
      sql`UPDATE memberships SET role='housekeeping' WHERE tenant_id='demo' AND user_id=${f.a1.id}`,
    );
    await f.db.query(
      sql`DELETE FROM property_grants WHERE tenant_id='demo' AND property_id='demo-1' AND user_id=${f.a1.id}`,
    );
    sheet = await f.worksheet(f.manager);
    expect(
      sheet.attendants.find((a) => a.id === f.a1.id)?.eligibilityReason,
    ).toBe("wrong_property");
    expect(
      Object.values(sheet.assignments).filter((id) => id === f.a1.id),
    ).toHaveLength(10);
    await f.db.query(
      sql`INSERT INTO property_grants VALUES ('demo',${f.a1.id},'demo-1')`,
    );
    await f.roleOk({
      userId: f.a1.id,
      propertyId: "demo-1",
      jobRole: "attendant",
    });
  });
  it("explains a scheduled attendant blocked by an unavailable team supervisor", async () => {
    await f.db.query(
      sql`UPDATE housekeeping_staff_schedules SET available=false WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${f.scope().date} AND shift_id='AM' AND user_id=${f.s1.id}`,
    );
    const sheet = await f.worksheet(f.manager);
    expect(sheet.attendants.find((a) => a.id === f.a1.id)).toMatchObject({
      active: true,
      available: true,
      eligibilityReason: null,
      assignmentBlockReason: "supervisor_unavailable",
    });
    const blocked = await f.command(
      [
        {
          type: "rooms",
          roomIds: [
            sheet.rooms.find((r) => sheet.assignments[r.id] !== f.a2.id)!.id,
          ],
          attendantId: f.a2.id,
        },
      ],
      f.manager,
    );
    expect(blocked.statusCode).toBe(409);
    expect(
      Object.keys((await f.worksheet(f.manager)).assignments),
    ).toHaveLength(30);
    await f.db.query(
      sql`UPDATE housekeeping_staff_schedules SET available=true WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${f.scope().date} AND shift_id='AM' AND user_id=${f.s1.id}`,
    );
  });
  it("keeps one winner for simultaneous revisions and enforces tenant/property/role scope", async () => {
    const before = await f.worksheet(f.s1),
      room = before.rooms[0].id;
    const results = await Promise.all([
      f.command(
        [{ type: "rooms", roomIds: [room], attendantId: f.a2.id }],
        f.s1,
        before.revision,
      ),
      f.command(
        [{ type: "rooms", roomIds: [room], attendantId: f.a3.id }],
        f.s1,
        before.revision,
      ),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const dup = await f.db.query(
      sql`SELECT room_id FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${f.scope().date} AND shift_id='AM' AND active GROUP BY room_id HAVING count(*)>1`,
    );
    expect(dup).toEqual([]);
    for (const auth of [f.other, f.front, f.noProperty])
      expect(
        (
          await f.call(
            "worksheet?" + new URLSearchParams(f.scope()),
            undefined,
            auth,
          )
        ).statusCode,
      ).toBe(403);
    const denied = await f.command(
      [
        {
          type: "floors",
          floorIds: ["03"],
          supervisorId: f.s1.id,
          replace: true,
        },
      ],
      f.s1,
    );
    expect(denied.statusCode).toBe(403);
    expect((await f.worksheet(f.s1, "PM")).assignments).toEqual({});
  });
});
