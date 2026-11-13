import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { housekeepingFixture } from "./housekeeping-fixture";
import { sql } from "../apps/api/src/db";
import { encrypt } from "../apps/api/src/security";
import {
  mapHousekeepingOverview,
  mergeHousekeepingTasks,
} from "../apps/api/src/housekeeping-mapper";
import { enforceOhipPolicy } from "../apps/api/src/ohip-policy";
import { readFileSync } from "node:fs";
import { RealOhipAdapter } from "../apps/api/src/ohip";

const date = "2026-11-12";
const overview = (hotelId = "HKHOTEL") => ({
  housekeepingRoomInfo: {
    housekeepingRooms: {
      hotelId,
      room: [
        {
          roomId: "V101",
          floor: "Garden",
          roomType: { roomType: "Villa" },
          housekeeping: {
            housekeepingRoomStatus: {
              housekeepingRoomStatus: "Dirty",
              frontOfficeStatus: "Occupied",
              reservationStatusList: ["DueOut", "Arrival"],
            },
            guestServiceRequest: "DoNotDisturb",
          },
          resvInfo: [
            {
              guestName: "DO NOT EXPOSE",
              profileId: { id: "private" },
              reservationId: { id: "secret" },
              vipStatus: { code: "VIP" },
            },
          ],
        },
        {
          roomId: "V102",
          floor: "Garden",
          roomType: { roomType: "Villa" },
          housekeeping: {
            housekeepingRoomStatus: {
              housekeepingRoomStatus: "Inspected",
              reservationStatusList: ["StayOver"],
            },
            guestServiceRequest: "MakeUpRoom",
          },
        },
        {
          roomId: "V103",
          roomType: { roomType: "Suite" },
          housekeeping: {
            housekeepingRoomStatus: {
              housekeepingRoomStatus: "OutOfOrder",
              reservationStatusList: [],
            },
          },
        },
        {
          roomId: "V104",
          floor: "Upper",
          roomType: { roomType: "Suite" },
          housekeeping: {
            housekeepingRoomStatus: {
              housekeepingRoomStatus: "OutOfService",
              reservationStatusList: [],
            },
          },
        },
      ],
    },
    hasMore: false,
  },
});
const tasks = () => ({
  taskAssignmentInfo: [
    {
      hotelId: "HKHOTEL",
      taskDate: date,
      taskCodes: [{ code: "DEEP", description: "Deep clean" }],
      taskSheets: [
        {
          hotelId: "HKHOTEL",
          date,
          sheetNumber: 1,
          rooms: [
            {
              roomId: "V101",
              totalCredits: 4,
              instructions: "Use approved supplies",
              hasPriority: true,
            },
          ],
        },
      ],
    },
  ],
});
let f: Awaited<ReturnType<typeof housekeepingFixture>>;
let overviewStatus = 200,
  taskStatus = 200;
const transport = vi.fn(async (url: string | URL | Request) => {
  const path = String(url);
  if (path.endsWith("/oauth/v1/tokens"))
    return Response.json({ access_token: "test-only-token", expires_in: 3600 });
  if (path.includes("/housekeepingOverview"))
    return overviewStatus === 200
      ? Response.json(overview())
      : Response.json({}, { status: overviewStatus });
  if (path.includes("/houseKeepingtasks"))
    return taskStatus === 200
      ? Response.json(tasks())
      : Response.json({}, { status: taskStatus });
  throw Error("Unexpected transport");
});
const originalKey = process.env.ENCRYPTION_KEY,
  originalHosts = process.env.OHIP_ALLOWED_HOSTS;
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.OHIP_ALLOWED_HOSTS = "hk.example.oraclecloud.com";
  f = await housekeepingFixture(false, {
    ohipTransport: transport as typeof fetch,
  });
  for (const d of [12, 13, 14, 15, 16, 17]) await f.plan(`2026-11-${d}`);
}, 60000);
afterAll(async () => {
  await f?.close();
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
  if (originalHosts === undefined) delete process.env.OHIP_ALLOWED_HOSTS;
  else process.env.OHIP_ALLOWED_HOSTS = originalHosts;
});
async function sheet(day = date, auth = f.admin) {
  const r = await f.call(
    "worksheet?" + new URLSearchParams(f.scope(day)),
    undefined,
    auth,
  );
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function move(
  day: string,
  operations: unknown[],
  baseRevision?: string,
  auth = f.admin,
  mutationId = randomUUID(),
) {
  return f.call(
    "worksheet",
    {
      ...f.scope(day),
      baseRevision: baseRevision || (await sheet(day, auth)).revision,
      mutationId,
      operations,
    },
    auth,
  );
}
describe("single-screen worksheet backend", () => {
  it("loads registered staff and all actual demo snapshot rooms with an explicit shift roster", async () => {
    const s = await sheet();
    expect(s.feed.source).toBe("DEMO");
    expect(s.rooms).toHaveLength(6);
    expect(s.attendants).toHaveLength(3);
    expect(s.supervisors).toHaveLength(2);
    expect(s.team).toEqual({});
    const op = [
      { type: "team", attendantId: f.a1.id, supervisorId: f.s1.id },
      { type: "rooms", roomIds: ["201", "206"], attendantId: f.a1.id },
    ];
    const r = await move(date, op);
    expect(r.statusCode, r.body).toBe(200);
    const saved = await sheet();
    expect(saved.assignments).toMatchObject({ "201": f.a1.id, "206": f.a1.id });
    expect(saved.team[f.a1.id]).toBe(f.s1.id);
    const schedules = await f.db.query(
      sql`SELECT user_id FROM housekeeping_staff_schedules WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${date}`,
    );
    expect(schedules).toHaveLength(5);
  });
  it("atomically transfers rooms across attendants and supervisor coverage", async () => {
    const r = await move(date, [
      { type: "team", attendantId: f.a2.id, supervisorId: f.s2.id },
      { type: "rooms", roomIds: ["201"], attendantId: f.a2.id },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    const s = await sheet();
    expect(s.assignments["201"]).toBe(f.a2.id);
    const rows = await f.db.query(
      sql`SELECT supervisor_id,coverage FROM housekeeping_supervisor_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${date}`,
    );
    expect(
      rows.find((r) => r.supervisor_id === f.s1.id)?.coverage,
    ).not.toContain("201");
    expect(rows.find((r) => r.supervisor_id === f.s2.id)?.coverage).toContain(
      "201",
    );
    expect(
      await f.db.query(
        sql`SELECT id FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${date} AND room_id='201' AND active`,
      ),
    ).toHaveLength(1);
  });
  it("moves an attendant and all their rooms to another supervisor in one transaction", async () => {
    const r = await move(date, [
      { type: "team", attendantId: f.a1.id, supervisorId: f.s2.id },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    expect((await sheet()).team[f.a1.id]).toBe(f.s2.id);
    const row = (
      await f.db.query(
        sql`SELECT coverage FROM housekeeping_supervisor_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${date} AND supervisor_id=${f.s2.id}`,
      )
    )[0];
    expect(row.coverage).toContain("206");
  });
  it("blocks concurrent stale edits, rolls back whole invalid batches, and supports idempotent retry", async () => {
    const day = "2026-11-13";
    let s = await sheet(day);
    const result = await Promise.all([
      move(
        day,
        [{ type: "team", attendantId: f.a1.id, supervisorId: f.s1.id }],
        s.revision,
      ),
      move(
        day,
        [{ type: "team", attendantId: f.a2.id, supervisorId: f.s2.id }],
        s.revision,
      ),
    ]);
    expect(result.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    s = await sheet(day);
    const before = JSON.stringify(s.assignments);
    const r = await move(
      day,
      [
        { type: "team", attendantId: f.a3.id, supervisorId: f.s1.id },
        {
          type: "rooms",
          roomIds: ["201", "unavailable-room"],
          attendantId: f.a3.id,
        },
      ],
      s.revision,
    );
    expect(r.statusCode).toBe(409);
    expect(JSON.stringify((await sheet(day)).assignments)).toBe(before);
    expect((await sheet(day)).team[f.a3.id]).toBeUndefined();
    s = await sheet(day);
    const mutationId = randomUUID(),
      ops = [{ type: "team", attendantId: f.a3.id, supervisorId: f.s1.id }];
    const first = await move(day, ops, s.revision, f.admin, mutationId),
      retry = await move(day, ops, s.revision, f.admin, mutationId);
    expect(first.statusCode, first.body).toBe(200);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().replayed).toBe(true);
    expect(retry.json().changeId).toBe(first.json().changeId);
  });
  it("undoes only the last move in a debounced batch and blocks undo after another edit", async () => {
    const day = "2026-11-14";
    const r = await move(day, [
      { type: "team", attendantId: f.a1.id, supervisorId: f.s1.id },
      { type: "rooms", roomIds: ["201", "202"], attendantId: f.a1.id },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    const undo = await f.call(
      "worksheet/undo",
      {
        ...f.scope(day),
        baseRevision: r.json().revision,
        mutationId: randomUUID(),
        changeId: r.json().changeId,
      },
      f.admin,
      "POST",
    );
    expect(undo.statusCode, undo.body).toBe(200);
    const s = await sheet(day);
    expect(s.assignments).toEqual({});
    expect(s.team[f.a1.id]).toBe(f.s1.id);
    const again = await move(day, [
      { type: "rooms", roomIds: ["201"], attendantId: f.a1.id },
    ]);
    await move(day, [
      { type: "team", attendantId: f.a2.id, supervisorId: f.s2.id },
    ]);
    expect(
      (
        await f.call(
          "worksheet/undo",
          {
            ...f.scope(day),
            baseRevision: (await sheet(day)).revision,
            mutationId: randomUUID(),
            changeId: again.json().changeId,
          },
          f.admin,
          "POST",
        )
      ).statusCode,
    ).toBe(409);
  });
  it("undoes an attendant move and preserves previous room progress", async () => {
    const day = "2026-11-15";
    await move(day, [
      { type: "team", attendantId: f.a1.id, supervisorId: f.s1.id },
      { type: "rooms", roomIds: ["201"], attendantId: f.a1.id },
    ]);
    await f.db.query(
      sql`UPDATE housekeeping_room_assignments SET local_status='completed' WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${day} AND room_id='201' AND active`,
    );
    const r = await move(day, [
      { type: "team", attendantId: f.a1.id, supervisorId: f.s2.id },
    ]);
    const undo = await f.call(
      "worksheet/undo",
      {
        ...f.scope(day),
        baseRevision: r.json().revision,
        mutationId: randomUUID(),
        changeId: r.json().changeId,
      },
      f.admin,
      "POST",
    );
    expect(undo.statusCode, undo.body).toBe(200);
    const s = await sheet(day);
    expect(s.team[f.a1.id]).toBe(f.s1.id);
    expect(s.localProgress["201"]).toBe("completed");
  });
  it("enforces staff availability, property, tenant and own-team RBAC", async () => {
    const day = "2026-11-16";
    await move(day, [
      { type: "team", attendantId: f.a1.id, supervisorId: f.s1.id },
      { type: "rooms", roomIds: ["201"], attendantId: f.a1.id },
    ]);
    expect(
      (
        await move(
          day,
          [{ type: "rooms", roomIds: ["202"], attendantId: f.a1.id }],
          undefined,
          f.a1,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(
          "worksheet?" + new URLSearchParams(f.scope(day)),
          undefined,
          f.other,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.call(
          "worksheet?" + new URLSearchParams(f.scope(day)),
          undefined,
          f.front,
        )
      ).statusCode,
    ).toBe(403);
    expect((await sheet(day, f.a1)).rooms.map((r: any) => r.id)).toEqual([
      "201",
    ]);
    expect((await sheet(day, f.s2)).rooms).toEqual([]);
    await f.ok("schedules", {
      ...f.scope(day),
      userId: f.a3.id,
      available: false,
    });
    expect(
      (
        await move(day, [
          { type: "team", attendantId: f.a3.id, supervisorId: f.s1.id },
        ])
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await move(day, [
          { type: "team", attendantId: f.noProperty.id, supervisorId: f.s1.id },
        ])
      ).statusCode,
    ).toBe(409);
  });
  it("never turns a verified local mapping without an OPERA snapshot into a live room", async () => {
    await f.ok("directory", {
      propertyId: "demo-1",
      roomId: "NOT-IN-FEED",
      floor: "Manual",
      departureCredits: 2,
      stayoverCredits: 1,
      validated: true,
    });
    expect((await sheet()).rooms.some((r: any) => r.id === "NOT-IN-FEED")).toBe(
      false,
    );
    expect(
      (
        await f.db.query(
          sql`SELECT count(*)::int AS n FROM housekeeping_worksheet_changes`,
        )
      )[0].n,
    ).toBeGreaterThan(0);
    expect(
      (
        await f.db.query(
          sql`SELECT count(*)::int AS n FROM audit_logs WHERE action='housekeeping.worksheet.move'`,
        )
      )[0].n,
    ).toBeGreaterThan(0);
  });
  it("allows authorized supervisors to manage only their existing team and coverage", async () => {
    const day = "2026-11-17";
    await move(day, [
      { type: "team", attendantId: f.a1.id, supervisorId: f.s1.id },
      { type: "rooms", roomIds: ["201"], attendantId: f.a1.id },
      { type: "team", attendantId: f.a2.id, supervisorId: f.s2.id },
      { type: "rooms", roomIds: ["203"], attendantId: f.a2.id },
    ]);
    await f.ok("supervisors", {
      ...f.scope(day),
      supervisorId: f.s1.id,
      floors: ["West"],
    });
    await f.roleOk({
      propertyId: "demo-1",
      userId: f.s1.id,
      department: "Housekeeping",
      jobRole: "supervisor",
      canManage: true,
    });
    const own = await sheet(day, f.s1);
    expect(own.rooms.map((r: any) => r.id)).toEqual(["201", "202"]);
    expect(
      own.attendants
        .filter((r: any) => own.team[r.id] === f.s1.id)
        .map((r: any) => r.id),
    ).toEqual([f.a1.id]);
    expect(own.attendants.map((r: any) => r.id)).not.toContain(f.a2.id);
    expect(
      (
        await move(
          day,
          [{ type: "rooms", roomIds: ["202"], attendantId: f.a1.id }],
          undefined,
          f.s1,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await move(
          day,
          [{ type: "rooms", roomIds: ["203"], attendantId: f.a1.id }],
          undefined,
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await move(
          day,
          [{ type: "team", attendantId: f.a1.id, supervisorId: f.s2.id }],
          undefined,
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await move(
          day,
          [{ type: "rooms", roomIds: ["201"], attendantId: f.a2.id }],
          undefined,
          f.s1,
        )
      ).statusCode,
    ).toBe(403);
  });
});
async function bindLive() {
  await f.db.query(
    sql`INSERT INTO ohip_connections(id,tenant_id,base_url,client_id,encrypted_client_secret,encrypted_app_key,enterprise_id,status) VALUES ('hk-feed','demo','https://hk.example.oraclecloud.com','client',${encrypt("synthetic-only")},${encrypt("synthetic-key")},'ENTERPRISE','connected') ON CONFLICT DO NOTHING`,
  );
  await f.db.query(
    sql`INSERT INTO ohip_connection_properties(id,tenant_id,connection_id,property_id,hotel_id,validation_status) VALUES ('hk-binding','demo','hk-feed','demo-1','HKHOTEL','validated') ON CONFLICT DO NOTHING`,
  );
  await f.db.query(
    sql`UPDATE connections SET mode='real' WHERE tenant_id='demo' AND property_id='demo-1'`,
  );
  await f.db.query(
    sql`DELETE FROM housekeeping_room_feeds WHERE tenant_id='demo' AND property_id='demo-1'`,
  );
}
describe("authorized OPERA room feed", () => {
  it("advances by actual server page size and publishes no silently truncated room list", async () => {
    const requests: string[] = [];
    const paged = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/oauth/v1/tokens"))
        return Response.json({
          access_token: "synthetic-paging-token",
          expires_in: 3600,
        });
      if (url.includes("/houseKeepingtasks"))
        return Response.json({ taskAssignmentInfo: [] });
      const offset = Number(new URL(url).searchParams.get("offset"));
      const body = overview();
      body.housekeepingRoomInfo.housekeepingRooms.room =
        body.housekeepingRoomInfo.housekeepingRooms.room.slice(
          offset,
          offset + 2,
        );
      body.housekeepingRoomInfo.hasMore = offset === 0;
      return Response.json(body);
    });
    const connection = {
      tenant_id: "t",
      property_id: "p",
      connection_id: "c",
      hotel_id: "HKHOTEL",
      enterprise_id: "E",
      gateway: "https://hk.example.oraclecloud.com",
      encrypted_secret: encrypt({
        clientId: "synthetic",
        clientSecret: "synthetic",
        applicationKey: "synthetic",
      }),
    };
    const adapter = new RealOhipAdapter(
      connection,
      paged as typeof fetch,
      undefined,
      {
        tenantId: "t",
        propertyId: "p",
        connectionId: "c",
        hotelId: "HKHOTEL",
        authorize: async () => true,
      },
    );
    expect((await adapter.readHousekeeping(date)).rooms).toHaveLength(4);
    expect(requests.some((p) => p.includes("offset=2&"))).toBe(true);
    const incomplete = overview() as any;
    incomplete.housekeepingRoomInfo.totalResults = 20;
    expect(() =>
      mapHousekeepingOverview(incomplete, date, "HKHOTEL"),
    ).toThrow();
  });
  it("maps the official overview/task schema, statuses, credits and floor without guest PII", () => {
    const mapped = mapHousekeepingOverview(overview(), date, "HKHOTEL");
    expect(mapped.rooms).toHaveLength(4);
    const merged = mergeHousekeepingTasks(
      mapped.rooms,
      tasks(),
      date,
      "HKHOTEL",
    );
    expect(merged[0]).toMatchObject({
      id: "V101",
      floor: "Garden",
      status: "Dirty",
      occupancy: "Occupied",
      departure: true,
      arrival: true,
      vip: true,
      dnd: true,
      credits: 4,
      creditSource: "OHIP",
      tasks: ["Deep clean"],
    });
    expect(merged[1]).toMatchObject({
      stayover: true,
      makeUpRoom: true,
      status: "Inspected",
    });
    expect(merged[2].outOfOrder).toBe(true);
    expect(merged[3].outOfService).toBe(true);
    expect(JSON.stringify(merged)).not.toMatch(
      /DO NOT EXPOSE|private|secret|guestName|reservationId/,
    );
    expect(() =>
      mapHousekeepingOverview(overview("OTHER"), date, "HKHOTEL"),
    ).toThrow();
  });
  it("loads live rooms automatically through authorized GETs and uses OHIP credits when available", async () => {
    await bindLive();
    transport.mockClear();
    const s = await sheet();
    expect(s.feed.available).toBe(true);
    expect(s.feed.source).toBe("OHIP");
    expect(s.rooms.map((r: any) => r.id)).toEqual([
      "V101",
      "V102",
      "V103",
      "V104",
    ]);
    expect(s.rooms[0].credits).toBe(4);
    expect(s.rooms[0].creditSource).toBe("OHIP");
    expect(s.rooms[1].credits).toBeNull();
    expect(JSON.stringify(s)).not.toMatch(
      /DO NOT EXPOSE|private|secret|guestName|reservationId/,
    );
    const calls = transport.mock.calls as unknown as [string, RequestInit][];
    for (const [url, options] of calls)
      if (!url.endsWith("/oauth/v1/tokens")) expect(options.method).toBe("GET");
    expect(
      calls.find(([url]) => url.includes("/houseKeepingtasks"))?.[0],
    ).toContain("generateCleaningSequence=false");
    const r = await move(date, [
      { type: "rooms", roomIds: ["V101"], attendantId: f.a1.id },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    expect((await sheet()).assignments.V101).toBe(f.a1.id);
    await f.ok("directory", {
      propertyId: "demo-1",
      roomId: "V101",
      floor: "Garden",
      departureCredits: 9,
      stayoverCredits: 5,
      otherCredits: 2,
      validated: true,
    });
    expect(
      (await sheet()).rooms.find((r: any) => r.id === "V101"),
    ).toMatchObject({ credits: 4, creditSource: "OHIP" });
    await f.ok("directory", {
      propertyId: "demo-1",
      roomId: "V104",
      floor: "Incorrect local floor",
      departureCredits: 1,
      stayoverCredits: 1,
      otherCredits: 0,
      validated: true,
    });
    await f.ok("directory", {
      propertyId: "demo-1",
      roomId: "V103",
      floor: "Validated roof",
      departureCredits: 1,
      stayoverCredits: 1,
      otherCredits: 0,
      validated: true,
    });
    const mapped = await sheet();
    expect(mapped.rooms.find((r: any) => r.id === "V104")).toMatchObject({
      floor: "Upper",
      floorSource: "OHIP",
    });
    expect(mapped.rooms.find((r: any) => r.id === "V103")).toMatchObject({
      floor: "Validated roof",
      floorSource: "local_validated",
    });
  });
  it("shows an explicit live error instead of local Unknown mappings when OHIP authorization fails", async () => {
    overviewStatus = 403;
    await bindLive();
    const s = await sheet();
    expect(s.feed.available).toBe(false);
    expect(s.rooms).toEqual([]);
    expect(s.feed.error).toMatch(/access denied/);
    expect(s.missingAssignedRooms).toBeGreaterThan(0);
    expect(
      (
        await move(date, [
          { type: "rooms", roomIds: ["201"], attendantId: f.a1.id },
        ])
      ).statusCode,
    ).toBe(409);
    overviewStatus = 200;
  });
  it("retains the authorized overview when task sheets are unavailable, with explicit credit provenance", async () => {
    taskStatus = 403;
    await bindLive();
    const s = await sheet();
    expect(s.feed.available).toBe(true);
    expect(s.feed.taskError).toContain("permission");
    expect(s.rooms[0].credits).toBe(9);
    expect(s.rooms[0].creditSource).toBe("local");
    expect(s.rooms[1].credits).toBeNull();
    expect(s.rooms[1].creditSource).toBe("not_configured");
    taskStatus = 200;
  });
});
describe("GET-only housekeeping policy", () => {
  const route = {
    tenant_id: "t",
    property_id: "p",
    connection_id: "c",
    hotel_id: "HOTEL",
    enterprise_id: "E",
  };
  const scope = {
    tenantId: "t",
    propertyId: "p",
    connectionId: "c",
    hotelId: "HOTEL",
    authorize: async () => true,
  };
  const options = {
    method: "GET",
    redirect: "error" as const,
    headers: {
      Authorization: "Bearer test",
      "x-app-key": "test",
      "x-hotelid": "HOTEL",
    },
  };
  const taskPath = `/hsk/v1/hotels/HOTEL/houseKeepingtasks?taskDate=${date}&generateCleaningSequence=false&includeReservationInfo=false&includeTaskSheetDetails=true&includeTaskSheetsSummary=true`;
  it("pins operation names and the sequence-generation hazard to official Oracle specs", () => {
    const spec = JSON.parse(
      readFileSync(
        new URL("../fixtures/oracle-hsk-26.3.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      spec.paths["/hotels/{hotelId}/housekeepingOverview"].get.operationId,
    ).toBe("getHousekeepingOverview");
    const task = spec.paths["/hotels/{hotelId}/houseKeepingtasks"].get;
    expect(task.operationId).toBe("getHouseKeepingTasks");
    expect(
      task.parameters.find((p: any) => p.name === "generateCleaningSequence")
        .description,
    ).toContain("generate a sequence");
  });
  it("permits only exact bounded GET reads and rejects mutations, sequence generation and arbitrary queries", async () => {
    await expect(
      enforceOhipPolicy(
        "getHouseKeepingTasks",
        taskPath,
        options,
        route,
        scope,
      ),
    ).resolves.toBeUndefined();
    await expect(
      enforceOhipPolicy(
        "getHousekeepingOverview",
        "/hsk/v1/hotels/HOTEL/housekeepingOverview?limit=100&offset=0&fetchInstructions=ResvInfo",
        options,
        route,
        scope,
      ),
    ).resolves.toBeUndefined();
    for (const path of [
      taskPath.replace(
        "generateCleaningSequence=false",
        "generateCleaningSequence=true",
      ),
      taskPath.replace("&generateCleaningSequence=false", ""),
      taskPath + "&roomStatusToChange=Clean",
      taskPath.replace(
        "includeReservationInfo=false",
        "includeReservationInfo=true",
      ),
      taskPath.replace("/HOTEL/", "/OTHER/"),
    ])
      await expect(
        enforceOhipPolicy("getHouseKeepingTasks", path, options, route, scope),
      ).rejects.toMatchObject({ statusCode: 403 });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      await expect(
        enforceOhipPolicy(
          "getHouseKeepingTasks",
          taskPath,
          { ...options, method },
          route,
          scope,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
  });
});
