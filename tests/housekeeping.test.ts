import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { housekeepingFixture, type Auth } from "./housekeeping-fixture";
import { sql, migrate } from "../apps/api/src/db";
import { appendEvent } from "../apps/api/src/realtime";
let f: Awaited<ReturnType<typeof housekeepingFixture>>;
beforeAll(async () => {
  f = await housekeepingFixture();
}, 60000);
afterAll(async () => {
  await f?.close();
});
async function supervisor(
  date: string,
  rooms: string[] = [],
  floors: string[] = [],
  supervisorId = f.s1.id,
) {
  return f.ok("supervisors", { ...f.scope(date), supervisorId, rooms, floors });
}
async function attendant(
  date: string,
  rooms: string[],
  attendantId = f.a1.id,
  supervisorId = f.s1.id,
  auth = f.admin,
) {
  return f.call(
    "attendants",
    { ...f.scope(date), attendantId, supervisorId, rooms },
    auth,
  );
}
describe("local Housekeeping assignments", () => {
  it("migrates idempotently and reuses registered users without a duplicate user table", async () => {
    await migrate(f.db);
    const r = await f.call("setup?propertyId=demo-1");
    expect(r.statusCode).toBe(200);
    expect(r.json().staff).toHaveLength(5);
    expect(r.body).not.toMatch(/password_hash|encrypted_secret/);
    expect(
      r.json().staff.every((u: any) => u.department === "Housekeeping"),
    ).toBe(true);
    expect(
      (await f.call("setup?propertyId=demo-1", undefined, f.front)).statusCode,
    ).toBe(403);
    expect(
      (await f.call("setup?propertyId=demo-1", undefined, f.it)).statusCode,
    ).toBe(200);
  });
  it("rejects missing, wrong-property, cross-tenant, inactive and wrong-role staff", async () => {
    const s = await f.plan("2026-11-13");
    for (const userId of [
      "missing",
      f.noProperty.id,
      "other-housekeeping",
      "demo-frontoffice",
    ]) {
      expect(
        (
          await f.call("staff", {
            propertyId: "demo-1",
            userId,
            department: "Housekeeping",
            jobRole: "attendant",
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await f.call("schedules", { ...s, userId, available: true }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (await f.call("setup?propertyId=demo-1", undefined, f.other)).statusCode,
    ).toBe(403);
    await f.db.query(
      sql`INSERT INTO local_archives(tenant_id,kind,target) VALUES ('demo','users',${f.a3.id})`,
    );
    expect(
      (await f.call("schedules", { ...s, userId: f.a3.id, available: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await f.call("staff", {
          propertyId: "demo-1",
          userId: f.a3.id,
          department: "Housekeeping",
          jobRole: "attendant",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.call("setup?propertyId=demo-1"))
        .json()
        .staff.some((r: any) => r.user_id === f.a3.id),
    ).toBe(false);
    await f.db.query(
      sql`DELETE FROM local_archives WHERE tenant_id='demo' AND kind='users' AND target=${f.a3.id}`,
    );
  });
  it("requires scheduled availability and a validated room directory with explicit floors", async () => {
    const s = f.scope("2026-11-14");
    expect(
      (
        await f.call("supervisors", {
          ...s,
          supervisorId: f.s1.id,
          floors: ["West"],
        })
      ).statusCode,
    ).toBe(409);
    await f.plan(s.date);
    expect(
      (
        await f.call("supervisors", {
          ...s,
          supervisorId: f.s1.id,
          floors: ["2"],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call("supervisors", {
          ...s,
          supervisorId: f.s1.id,
          rooms: ["206"],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call("directory", {
          propertyId: "demo-1",
          roomId: "999",
          floor: "X",
          departureCredits: 2,
          stayoverCredits: 1,
          validated: false,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.call("directory", {
          propertyId: "demo-1",
          roomId: "201",
          floor: "X",
          departureCredits: 2,
          stayoverCredits: 1,
          validated: false,
        })
      ).statusCode,
    ).toBe(400);
  });
  it("supports multiple floors, specific rooms and mixed supervisor coverage", async () => {
    const date = "2026-11-15";
    await f.plan(date);
    expect((await supervisor(date, [], ["West", "East"])).coverage).toEqual([
      "201",
      "202",
      "203",
      "204",
    ]);
    expect((await supervisor(date, ["205"])).coverage).toEqual(["205"]);
    expect((await supervisor(date, ["205"], ["West"])).coverage).toEqual([
      "201",
      "202",
      "205",
    ]);
    expect(
      (
        await f.call("supervisors", {
          ...f.scope(date),
          supervisorId: f.s2.id,
          rooms: ["201"],
        })
      ).statusCode,
    ).toBe(409);
  });
  it("assigns attendants under supervisors with floor/section/room selectors", async () => {
    const date = "2026-11-16";
    await f.plan(date);
    await supervisor(date, [], ["West", "East", "Annex"]);
    const r = await f.call("attendants", {
      ...f.scope(date),
      attendantId: f.a1.id,
      supervisorId: f.s1.id,
      floors: ["West"],
      sections: ["B"],
      rooms: ["205"],
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().rooms).toEqual(["201", "202", "204", "205"]);
    const b = await f.board(date);
    expect(b.supervisors[0].attendants[0].attendant_id).toBe(f.a1.id);
    expect(b.unassignedRooms).toEqual(["203"]);
    expect(b.unmappedRooms).toEqual([{ id: "206" }]);
    expect(b.unassignedAvailableAttendants).toHaveLength(2);
  });
  it("rejects rooms outside supervisor coverage and shrinking coverage under assigned rooms", async () => {
    const date = "2026-11-17";
    await f.plan(date);
    await supervisor(date, [], ["West"]);
    expect((await attendant(date, ["203"])).statusCode).toBe(409);
    expect((await attendant(date, ["201"])).statusCode).toBe(200);
    expect(
      (
        await f.call("supervisors", {
          ...f.scope(date),
          supervisorId: f.s1.id,
          rooms: [],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call("schedules", {
          ...f.scope(date),
          userId: f.a1.id,
          available: false,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call("schedules", {
          ...f.scope(date),
          userId: f.s1.id,
          available: false,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call("directory", {
          propertyId: "demo-1",
          roomId: "201",
          floor: "Changed",
          departureCredits: 2,
          stayoverCredits: 1,
          validated: true,
        })
      ).statusCode,
    ).toBe(409);
  });
  it("blocks duplicate active rooms including competing transactions, with a database unique constraint", async () => {
    const date = "2026-11-18";
    await f.plan(date);
    await supervisor(date, [], ["West"]);
    const results = await Promise.all([
      attendant(date, ["201"]),
      attendant(date, ["201"], f.a2.id),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const row = (
      await f.db.query(
        sql`SELECT * FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${date} AND active`,
      )
    )[0];
    await expect(
      f.db.query(
        sql`INSERT INTO housekeeping_room_assignments(id,tenant_id,property_id,business_date,shift_id,attendant_id,room_id,baseline_status,baseline_attention,baseline_at) VALUES ('duplicate','demo','demo-1',${date},'AM',${row.attendant_id},'201','dirty','',now())`,
      ),
    ).rejects.toThrow();
  });
  it("isolates dates and shifts and retains released room history during a local move", async () => {
    const date = "2026-11-19";
    await f.plan(date);
    await supervisor(date, [], ["West"]);
    expect((await attendant(date, ["201"])).statusCode).toBe(200);
    expect(
      (await f.board("2026-11-20")).rooms.every((r: any) => !r.assignment),
    ).toBe(true);
    expect(
      (await f.board(date, f.admin, "PM")).rooms.every(
        (r: any) => !r.assignment,
      ),
    ).toBe(true);
    const s = await f.plan(date, "PM");
    await f.ok("supervisors", {
      ...s,
      supervisorId: f.s1.id,
      floors: ["West"],
    });
    expect(
      (
        await f.call("attendants", {
          ...s,
          supervisorId: f.s1.id,
          attendantId: f.a2.id,
          rooms: ["201"],
        })
      ).statusCode,
    ).toBe(200);
    expect((await attendant(date, [])).statusCode).toBe(200);
    expect((await attendant(date, ["201"], f.a2.id)).statusCode).toBe(200);
    const history = await f.db.query(
      sql`SELECT active,local_status FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${date} AND shift_id='AM' AND room_id='201'`,
    );
    expect(history).toHaveLength(2);
    expect(
      history.some((r) => !r.active && r.local_status === "released"),
    ).toBe(true);
  });
  it("aggregates departure/stayover credits and warns about workload distribution", async () => {
    const date = "2026-11-21";
    await f.plan(date);
    await supervisor(date, [], ["West", "East"]);
    await f.db.query(
      sql`INSERT INTO reservations(id,tenant_id,property_id,confirmation,guest_name,arrival,departure,status,room,source) VALUES ('hk-dep','demo','demo-1','TEST','Synthetic',${date}::date-1,${date},'DueOut','201','DEMO'),('hk-stay','demo','demo-1','TEST','Synthetic',${date}::date-1,${date}::date+1,'InHouse','202','DEMO')`,
    );
    expect((await attendant(date, ["201", "202"])).statusCode).toBe(200);
    const b = await f.board(date);
    expect(b.workload).toMatchObject({
      rooms: 2,
      departure: 1,
      stayover: 1,
      credits: 3.75,
      outstanding: 2,
    });
    expect(b.supervisors[0].workload.credits).toBe(3.75);
    expect(b.attendants[0].workload.credits).toBe(3.75);
    expect(b.warnings.join()).toContain("150%");
    expect(JSON.stringify(b)).not.toContain("Synthetic");
  });
  it("separates OPERA observations from explicit local completion and surfaces PMR/DND", async () => {
    const date = "2026-11-22";
    await f.plan(date);
    await supervisor(date, ["201"]);
    await attendant(date, ["201"]);
    await f.db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE rooms SET status='inspected',attention='DND / PMR discrepancy',updated_at=now() WHERE tenant_id='demo' AND property_id='demo-1' AND id='201'`,
      );
      await appendEvent(tx, "demo", "demo-1", "rooms");
    });
    let b = await f.board(date);
    const room = b.rooms.find((r: any) => r.room_id === "201");
    expect(room.snapshotChanged).toBe(true);
    expect(room.assignment.local_status).toBe("assigned");
    expect(b.workload).toMatchObject({
      inspected: 1,
      outstanding: 1,
      discrepancies: 1,
    });
    expect(b.lastOhipSync).toBeNull();
    expect(b.snapshotNotice).toContain("not proof");
    expect(
      (
        await f.call(
          "progress/" + room.assignment.id,
          { ...f.scope(date), status: "completed" },
          f.admin,
          "PATCH",
        )
      ).statusCode,
    ).toBe(200);
    b = await f.board(date);
    expect(b.workload.outstanding).toBe(0);
    expect(b.rooms[0].status).toBe("inspected");
  });
  it("enforces API manager/supervisor/attendant permissions and own-team visibility", async () => {
    const date = "2026-11-23";
    await f.plan(date);
    await supervisor(date, [], ["West"]);
    await supervisor(date, [], ["East"], f.s2.id);
    await attendant(date, ["201"]);
    await attendant(date, ["203"], f.a2.id, f.s2.id);
    const own = await f.board(date, f.s1);
    expect(own.supervisors).toHaveLength(1);
    expect(own.rooms.map((r: any) => r.room_id)).toEqual(["201", "202"]);
    const ra = await f.board(date, f.a1);
    expect(ra.rooms.map((r: any) => r.room_id)).toEqual(["201"]);
    expect(ra.attendants).toHaveLength(1);
    expect(ra.canManage).toBe(false);
    expect(ra.assignableStaff).toEqual([]);
    expect(
      (await attendant(date, ["202"], f.a1.id, f.s1.id, f.s1)).statusCode,
    ).toBe(403);
    await f.ok("staff", {
      propertyId: "demo-1",
      userId: f.s1.id,
      department: "Housekeeping",
      jobRole: "supervisor",
      canManage: true,
    });
    expect(
      (await attendant(date, ["202"], f.a1.id, f.s1.id, f.s1)).statusCode,
    ).toBe(200);
    expect(
      (await attendant(date, ["202"], f.a2.id, f.s1.id, f.s1)).statusCode,
    ).toBe(403);
    expect(
      (await attendant(date, ["204"], f.a1.id, f.s2.id, f.s1)).statusCode,
    ).toBe(403);
    expect(
      (await attendant(date, ["202"], f.a1.id, f.s1.id, f.a1)).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(
          "supervisors",
          { ...f.scope(date), supervisorId: f.s1.id, floors: ["West"] },
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(
          "staff",
          {
            propertyId: "demo-1",
            userId: f.a1.id,
            department: "Housekeeping",
            jobRole: "manager",
          },
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          url: "/api/rooms?propertyId=demo-1",
          headers: { cookie: f.a1.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url: "/api/rooms/201",
          headers: { cookie: f.a1.cookie, "x-csrf-token": f.a1.csrf },
          payload: { propertyId: "demo-1", status: "clean", attention: "" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("supports an HK Manager from existing housekeeping membership and denies privilege self-grants", async () => {
    await f.ok("staff", {
      propertyId: "demo-1",
      userId: "demo-housekeeping",
      department: "Housekeeping",
      jobRole: "manager",
    });
    const hk = await f.login("housekeeping@demo.local");
    expect(
      (await f.call("setup?propertyId=demo-1", undefined, hk)).json().manager,
    ).toBe(true);
    expect(
      (
        await f.call(
          "shifts",
          {
            propertyId: "demo-1",
            id: "NIGHT",
            name: "Night",
            startsAt: "23:00",
            endsAt: "07:00",
          },
          hk,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await f.call(
          "staff",
          {
            propertyId: "demo-1",
            userId: f.s1.id,
            department: "Housekeeping",
            jobRole: "manager",
          },
          hk,
        )
      ).statusCode,
    ).toBe(403);
  });
  it("requires CSRF, rejects tenant overrides and keeps Oracle mutation routes blocked", async () => {
    expect(
      (
        await f.app.inject({
          method: "PUT",
          url: "/api/local-housekeeping/shifts",
          headers: { cookie: f.admin.cookie },
          payload: {
            propertyId: "demo-1",
            id: "X",
            name: "X",
            startsAt: "01:00",
            endsAt: "02:00",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(
          "board?" + new URLSearchParams({ ...f.scope(), tenantId: "other" }),
        )
      ).statusCode,
    ).toBe(400);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const r = await f.app.inject({
        method,
        url: "/api/ohip/housekeeping/taskSheets",
        headers: { cookie: f.admin.cookie, "x-csrf-token": f.admin.csrf },
        payload: {},
      });
      expect(r.statusCode).toBe(403);
      expect(r.body).toContain("OHIP_READ_ONLY_POLICY");
    }
    expect(
      (
        await f.db.query(
          sql`SELECT count(*)::int AS n FROM audit_logs WHERE action LIKE 'housekeeping.%'`,
        )
      )[0].n,
    ).toBeGreaterThan(0);
  });
  it("allows local assignment on an Oracle-mapped property without Oracle transport or task sheet writes", async () => {
    const date = "2026-11-24";
    await f.plan(date);
    await supervisor(date, ["201"]);
    await f.db.query(
      sql`UPDATE connections SET mode='real',last_sync='2026-11-12T01:00:00Z',status='synced' WHERE tenant_id='demo' AND property_id='demo-1'`,
    );
    const before = (
      await f.db.query(sql`SELECT count(*)::int AS n FROM tasks`)
    )[0].n;
    expect((await attendant(date, ["201"])).statusCode).toBe(200);
    const b = await f.board(date);
    expect(new Date(b.lastOhipSync).toISOString()).toBe(
      "2026-11-12T01:00:00.000Z",
    );
    expect(
      (await f.db.query(sql`SELECT count(*)::int AS n FROM tasks`))[0].n,
    ).toBe(before);
    expect(
      (
        await f.app.inject({
          method: "PATCH",
          url: "/api/rooms/201",
          headers: { cookie: f.admin.cookie, "x-csrf-token": f.admin.csrf },
          payload: { propertyId: "demo-1", status: "clean", attention: "" },
        })
      ).statusCode,
    ).toBe(403);
    await f.db.query(
      sql`UPDATE connections SET mode='demo',last_sync=NULL WHERE tenant_id='demo' AND property_id='demo-1'`,
    );
  });
});

async function socket(auth: Auth) {
  const events: any[] = [];
  const ws = new WebSocket(
    f.base.replace("http", "ws") +
      `/api/ws?after=0&csrf=${encodeURIComponent(auth.csrf)}`,
    { headers: { cookie: auth.cookie } },
  );
  ws.on("message", (data) => events.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  await expect
    .poll(() => events.some((e) => e.topic === "heartbeat"), { timeout: 5000 })
    .toBe(true);
  events.length = 0;
  return { ws, events };
}
describe("Housekeeping WebSocket enforcement", () => {
  it("lets a manager release deactivated staff coverage and rooms without allowing new assignments to them", async () => {
    const date = "2026-11-26";
    await f.plan(date);
    await supervisor(date, [], ["West"], f.s2.id);
    await attendant(date, ["201"], f.a3.id, f.s2.id);
    await f.db.query(
      sql`INSERT INTO local_archives(tenant_id,kind,target) VALUES ('demo','users',${f.a3.id}),('demo','users',${f.s2.id})`,
    );
    try {
      expect(
        (await attendant(date, ["202"], f.a3.id, f.s2.id)).statusCode,
      ).toBe(400);
      expect((await attendant(date, [], f.a3.id, f.s2.id)).statusCode).toBe(
        200,
      );
      expect(
        (
          await f.call("supervisors", {
            ...f.scope(date),
            supervisorId: f.s2.id,
            rooms: [],
            floors: [],
          })
        ).statusCode,
      ).toBe(200);
      await supervisor(date, [], ["West"]);
      expect((await attendant(date, ["201"])).statusCode).toBe(200);
    } finally {
      await f.db.query(
        sql`DELETE FROM local_archives WHERE tenant_id='demo' AND kind='users' AND target IN (${f.a3.id},${f.s2.id})`,
      );
    }
  });
  it("allows a validated local property directory before an OHIP room feed exists, without inventing OPERA state", async () => {
    const date = "2026-11-25";
    await f.plan(date);
    await f.ok("directory", {
      propertyId: "demo-1",
      roomId: "VILLA-A",
      floor: "Garden",
      section: "Villas",
      departureCredits: 3,
      stayoverCredits: 2,
      otherCredits: 0,
      validated: true,
    });
    await supervisor(date, ["VILLA-A"]);
    expect((await attendant(date, ["VILLA-A"])).statusCode).toBe(200);
    const b = await f.board(date);
    const room = b.rooms.find((r: any) => r.room_id === "VILLA-A");
    expect(room.status).toBe("unknown");
    expect(room.updated_at).toBeNull();
    expect(room.assignment.baseline_at).toBeNull();
    expect(room.attention).toBe("Room snapshot unavailable");
    expect(
      await f.db.query(
        sql`SELECT id FROM rooms WHERE tenant_id='demo' AND property_id='demo-1' AND id='VILLA-A'`,
      ),
    ).toEqual([]);
  });
  it("broadcasts local changes only to permitted property roles, and delivers room snapshot invalidation", async () => {
    const allowed = await socket(f.admin),
      spv = await socket(f.s1),
      front = await socket(f.front),
      other = await socket(f.other);
    try {
      await f.ok("shifts", {
        propertyId: "demo-1",
        id: "RT",
        name: "Realtime",
        startsAt: "01:00",
        endsAt: "02:00",
      });
      await expect
        .poll(() => allowed.events.some((e) => e.topic === "housekeeping"), {
          timeout: 5000,
        })
        .toBe(true);
      await expect
        .poll(() => spv.events.some((e) => e.topic === "housekeeping"), {
          timeout: 5000,
        })
        .toBe(true);
      expect(front.events.some((e) => e.topic === "housekeeping")).toBe(false);
      expect(other.events.some((e) => e.propertyId === "demo-1")).toBe(false);
      await f.db.orm.transaction(async (tx) =>
        appendEvent(tx, "demo", "demo-1", "rooms"),
      );
      await expect
        .poll(() => spv.events.some((e) => e.topic === "rooms"), {
          timeout: 5000,
        })
        .toBe(true);
      expect(
        allowed.events.find((e) => e.topic === "housekeeping"),
      ).not.toHaveProperty("staff");
      // Revoking the property grant applies to an already connected socket.
      await f.db.query(
        sql`DELETE FROM property_grants WHERE tenant_id='demo' AND property_id='demo-1' AND user_id=${f.s1.id}`,
      );
      spv.events.length = 0;
      await f.ok("shifts", {
        propertyId: "demo-1",
        id: "RT",
        name: "After revocation",
        startsAt: "01:00",
        endsAt: "02:00",
      });
      await expect
        .poll(() =>
          allowed.events.some(
            (e) =>
              e.topic === "housekeeping" &&
              e.seq > Math.max(...spv.events.map((e) => e.seq), 0),
          ),
        )
        .toBe(true);
      await new Promise((r) => setTimeout(r, 1100));
      expect(spv.events.some((e) => e.topic === "housekeeping")).toBe(false);
      expect(
        (await f.call("setup?propertyId=demo-1", undefined, f.s1)).statusCode,
      ).toBe(403);
    } finally {
      for (const s of [allowed, spv, front, other]) s.ws.close();
    }
  });
  it("closes established sockets when the registered account is archived", async () => {
    const s = await socket(f.a3);
    const closed = new Promise<number>((resolve) =>
      s.ws.once("close", (code) => resolve(code)),
    );
    await f.db.query(
      sql`INSERT INTO local_archives(tenant_id,kind,target) VALUES ('demo','users',${f.a3.id})`,
    );
    expect(await closed).toBe(1008);
  });
});
