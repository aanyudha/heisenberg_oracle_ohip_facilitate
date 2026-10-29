import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { migrate, sql, type Database } from "../apps/api/src/db";
import { isolatedDatabase } from "./isolated-database";
import { buildApp } from "../apps/api/src/app";
import { seed } from "../apps/api/src/seed";
import { decrypt } from "../apps/api/src/security";
import { worker } from "../apps/api/src/worker";
import { connectionDispatch } from "../apps/api/src/connection-control";
let db: Database, app: Awaited<ReturnType<typeof buildApp>>;
let admin: any, itUser: any, other: any, front: any;
let closeDatabase: () => Promise<void>;
const password = "OCIM-test-login-password!";
const denied = new Set<string>();
let oauthFails = false;
const calls: { url: string; options: any }[] = [];
const transport = vi.fn(async (url: any, options: any) => {
  calls.push({ url: String(url), options });
  if (String(url).endsWith("/tokens"))
    return oauthFails
      ? new Response(null, { status: 401 })
      : Response.json({
          access_token: "token-" + calls.length,
          expires_in: 3600,
        });
  if (denied.has(options.headers["x-hotelid"]))
    return new Response(null, { status: 403 });
  return Response.json({
    reservations: { reservationInfo: [], hasMore: false },
  });
}) as unknown as typeof fetch;
async function login(email: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { email, password },
    remoteAddress: "127.0.2." + (Math.floor(Math.random() * 200) + 1),
  });
  expect(r.statusCode).toBe(200);
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join(";");
  const me = await app.inject({ url: "/api/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}
async function property(tenant = "demo", grants = ["demo-admin"]) {
  const id = "ocim-" + randomUUID();
  await db.query(
    sql`INSERT INTO properties(id,tenant_id,organization_id,name) VALUES (${id},${tenant},${tenant + "-group"},${id})`,
  );
  for (const user of grants)
    await db.query(
      sql`INSERT INTO property_grants VALUES (${tenant},${user},${id})`,
    );
  return id;
}
const body = (propertyId: string, suffix = randomUUID()) => ({
  propertyId,
  baseUrl: "https://gateway.example.oraclecloud.com",
  clientId: "client-" + suffix,
  clientSecret: "client-secret-" + suffix,
  appKey: "app-key-" + suffix,
  enterpriseId: "ENTERPRISE",
  hotelId: "HOTEL_A",
});
const create = (value: ReturnType<typeof body>, headers = admin) =>
  app.inject({
    method: "POST",
    url: "/api/ohip-connections",
    headers,
    payload: value,
  });
const assign = (
  id: string,
  propertyId: string,
  hotelId: string,
  headers = admin,
) =>
  app.inject({
    method: "POST",
    url: `/api/ohip-connections/${id}/assign`,
    headers,
    payload: { propertyId, hotelId },
  });
const edit = (id: string, payload: any, headers = admin) =>
  app.inject({
    method: "PATCH",
    url: `/api/ohip-connections/${id}`,
    headers,
    payload,
  });
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = "b".repeat(64);
  process.env.OHIP_ALLOWED_HOSTS = "gateway.example.oraclecloud.com";
  const isolated = await isolatedDatabase();
  db = isolated.db;
  closeDatabase = isolated.close;
  await migrate(db);
  await seed(db, password);
  app = await buildApp(db, { ohipTransport: transport });
  admin = await login("admin@demo.local");
  itUser = await login("it@demo.local");
  other = await login("admin@other.local");
  front = await login("frontoffice@demo.local");
}, 60000);
afterAll(async () => {
  await app?.close();
  await closeDatabase?.();
});
describe("OCIM connection center", () => {
  it("persists property/global pause, blocks outbound and polling, resumes without affecting another property and audits every control", async () => {
    const a = await property(),
      b = await property();
    const r = await create(body(a));
    expect(r.statusCode, r.body).toBe(200);
    const cid = r.json().id;
    expect((await assign(cid, b, "HOTEL_B")).statusCode).toBe(200);
    const control = (action: string, propertyId?: string, headers = admin) =>
      app.inject({
        method: "POST",
        url: `/api/ohip-connections/${cid}/control`,
        headers,
        payload: {
          action,
          ...(propertyId ? { propertyId } : { confirmGlobal: true }),
        },
      });
    expect((await control("pause", a, itUser)).statusCode).toBe(403);
    expect((await control("pause", a, other)).statusCode).toBe(403);
    expect((await control("pause", a)).statusCode).toBe(200);
    const send = vi.fn(async () => Response.json({}));
    await expect(connectionDispatch(db, "demo", a, cid)(send)).rejects.toThrow(
      "OHIP_READ_ONLY_POLICY",
    );
    expect(send).not.toHaveBeenCalled();
    await connectionDispatch(db, "demo", b, cid)(send);
    expect(send).toHaveBeenCalledTimes(1);
    const restartedApp = await buildApp(db, { ohipTransport: transport });
    try {
      const list = await restartedApp.inject({
        url: `/api/ohip-connections?propertyId=${a}`,
        headers: admin,
      });
      const c = list.json().items.find((c: any) => c.id === cid);
      expect(
        c.assigned_properties.find((m: any) => m.property_id === a),
      ).toMatchObject({ paused: true, status: "PAUSED", data_status: "Stale" });
      expect(
        c.assigned_properties.find((m: any) => m.property_id === b).paused,
      ).toBe(false);
    } finally {
      await restartedApp.close();
    }
    await db.query(
      sql`UPDATE connections SET next_poll=now() WHERE property_id IN (${a},${b})`,
    );
    const read = vi.fn(async () => ({ items: [], status: 200 }));
    await worker(
      db,
      (c) =>
        ({
          read: async () => {
            if (c.property_id === a) throw Error("paused property polled");
            return read();
          },
          testConnection: async () => true,
        }) as any,
    ).tick();
    expect(
      await db.query(sql`SELECT * FROM retry_jobs WHERE property_id=${a}`),
    ).toHaveLength(0);
    const retryId = randomUUID();
    await db.query(
      sql`INSERT INTO retry_jobs(id,tenant_id,property_id,operation,idempotency_key,state) VALUES (${retryId},'demo',${a},'reservation_poll',${retryId},'dead')`,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/retry-jobs/${retryId}/retry`,
          headers: admin,
          payload: { propertyId: a },
        })
      ).statusCode,
    ).toBe(409);
    expect((await control("resume", a)).statusCode).toBe(200);
    expect(
      (
        await db.query(
          sql`SELECT status,next_poll<=now() AS due FROM connections WHERE property_id=${a}`,
        )
      )[0],
    ).toMatchObject({ status: "not_connected", due: true });
    read.mockClear();
    await db.query(
      sql`UPDATE connections SET next_poll=now()+interval '1 day'`,
    );
    await db.query(
      sql`UPDATE connections SET next_poll=now() WHERE property_id=${a}`,
    );
    await worker(db, () => ({ read }) as any).tick();
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.query(
          sql`SELECT status FROM connections WHERE property_id=${a}`,
        )
      )[0].status,
    ).toBe("connected");
    expect((await control("pause")).statusCode).toBe(200);
    for (const p of [a, b])
      await expect(
        connectionDispatch(db, "demo", p, cid)(send),
      ).rejects.toThrow();
    expect((await control("resume", a)).statusCode).toBe(409);
    expect((await control("resume")).statusCode).toBe(200);
    await connectionDispatch(db, "demo", a, cid)(send);
    expect((await control("archive")).statusCode).toBe(200);
    await expect(
      connectionDispatch(db, "demo", b, cid)(send),
    ).rejects.toThrow();
    expect(
      (
        await db.query(
          sql`SELECT action FROM audit_logs WHERE target=${cid} AND action IN ('connection.pause','connection.resume','connection.archive')`,
        )
      ).length,
    ).toBe(8);
  });
  it("serializes global pause after in-flight dispatch and rejects the next request", async () => {
    const p = await property(),
      r = await create(body(p)),
      cid = r.json().id;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        started = r;
      });
    const dispatch = connectionDispatch(db, "demo", p, cid);
    const inflight = dispatch(async () => {
      started();
      await gate;
      return Response.json({});
    });
    await ready;
    let stopped = false;
    const pause = app
      .inject({
        method: "POST",
        url: `/api/ohip-connections/${cid}/control`,
        headers: admin,
        payload: { action: "pause", confirmGlobal: true },
      })
      .then((r) => {
        stopped = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    release();
    await inflight;
    expect((await pause).statusCode).toBe(200);
    const send = vi.fn(async () => Response.json({}));
    await expect(dispatch(send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a worker snapshot that raced with a property pause/resume cycle", async () => {
    const p = await property(),
      created = await create(body(p)),
      cid = created.json().id;
    await db.query(sql`DELETE FROM retry_jobs`);
    await db.query(
      sql`UPDATE connections SET next_poll=now()+interval '1 day'`,
    );
    await db.query(
      sql`UPDATE connections SET next_poll=now() WHERE property_id=${p}`,
    );
    const w = worker(
      db,
      () =>
        ({
          read: async () => {
            for (const action of ["pause", "resume"]) {
              const r = await app.inject({
                method: "POST",
                url: `/api/ohip-connections/${cid}/control`,
                headers: admin,
                payload: { action, propertyId: p },
              });
              expect(r.statusCode, r.body).toBe(200);
            }
            return { items: [], status: 200 };
          },
        }) as any,
    );
    await w.tick();
    expect(
      (
        await db.query(
          sql`SELECT last_sync FROM connections WHERE property_id=${p}`,
        )
      )[0].last_sync,
    ).toBeNull();
    expect(
      (
        await db.query(
          sql`SELECT last_error FROM retry_jobs WHERE property_id=${p}`,
        )
      )[0].last_error,
    ).toBe("connection_changed");
  });
  it("accepts exactly six connection parameters plus authorized property context; redacts stored secrets", async () => {
    const p = await property(),
      value = body(p),
      start = calls.length,
      r = await create(value);
    expect(r.statusCode, r.body).toBe(200);
    const row = (
      await db.query(
        sql`SELECT * FROM ohip_connections WHERE id=${r.json().id}`,
      )
    )[0];
    expect(row.client_id).toBe(value.clientId);
    expect(decrypt(row.encrypted_client_secret)).toBe(value.clientSecret);
    expect(decrypt(row.encrypted_app_key)).toBe(value.appKey);
    const list = await app.inject({
      url: `/api/ohip-connections?propertyId=${p}`,
      headers: admin,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toMatch(/encrypted_|client-secret-|app-key-/);
    expect(
      list.json().items.find((c: any) => c.id === row.id).assigned_properties,
    ).toEqual([
      expect.objectContaining({
        property_id: p,
        hotel_id: "HOTEL_A",
        validation_status: "validated",
        is_primary: true,
      }),
    ]);
    const oauth = calls.slice(start).find((c) => c.url.endsWith("/tokens"))!;
    expect(new URLSearchParams(oauth.options.body).get("scope")).toBe(
      "urn:opc:hgbu:ws:__myscopes__",
    );
    expect(oauth.options.headers.enterpriseId).toBe("ENTERPRISE");
    expect(oauth.options.headers["x-app-key"]).toBe(value.appKey);
    expect(oauth.options.headers.Authorization).toBe(
      "Basic " +
        Buffer.from(`${value.clientId}:${value.clientSecret}`).toString(
          "base64",
        ),
    );
    const check = calls.slice(start).find((c) => !c.url.endsWith("/tokens"))!;
    expect(check.url).toContain("/hotels/HOTEL_A/reservations/searches");
    expect(check.options.headers["x-hotelid"]).toBe("HOTEL_A");
    expect(check.options.headers.Authorization).toMatch(/^Bearer /);
    expect(
      JSON.stringify(
        (app.swagger() as any).paths["/api/ohip-connections"].post.requestBody,
      ),
    ).not.toContain("chainCode");
    const logs = await db.query(
      sql`SELECT action,target FROM audit_logs WHERE property_id=${p}`,
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ action: "connection.assign", target: row.id }),
    );
    expect(JSON.stringify(logs)).not.toContain(value.clientSecret);
  });
  it("shares one credential row across distinct Hotel IDs, deduplicates repeated credentials, and supports dedicated credentials", async () => {
    const a = await property(),
      b = await property(),
      c = await property(),
      value = body(a),
      created = await create(value),
      id = created.json().id;
    expect((await assign(id, b, "HOTEL_B")).statusCode).toBe(200);
    const duplicate = await create({
      ...value,
      propertyId: c,
      hotelId: "HOTEL_C",
    });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    expect(duplicate.json().id).toBe(id);
    expect(
      await db.query(
        sql`SELECT id FROM ohip_connections WHERE tenant_id='demo' AND client_id=${value.clientId}`,
      ),
    ).toHaveLength(1);
    const dedicated = await create({
      ...value,
      propertyId: c,
      clientSecret: value.clientSecret + "-dedicated",
      hotelId: "HOTEL_C",
    });
    expect(dedicated.statusCode, dedicated.body).toBe(200);
    expect(dedicated.json().id).not.toBe(id);
    const maps = await db.query(
      sql`SELECT connection_id,property_id,hotel_id FROM ohip_connection_properties WHERE property_id IN (${a},${b},${c}) ORDER BY hotel_id`,
    );
    expect(maps.map((m) => m.hotel_id)).toEqual([
      "HOTEL_A",
      "HOTEL_B",
      "HOTEL_C",
    ]);
    expect(maps[0].connection_id).toBe(maps[1].connection_id);
    expect(maps[2].connection_id).not.toBe(id);
  });
  it("deduplicates concurrent creation within the same tenant", async () => {
    const a = await property(),
      b = await property(),
      value = body(a);
    const [first, second] = await Promise.all([
      create(value),
      create({ ...value, propertyId: b, hotelId: "HOTEL_B" }),
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(second.statusCode, second.body).toBe(200);
    expect(first.json().id).toBe(second.json().id);
    expect(
      await db.query(
        sql`SELECT id FROM ohip_connections WHERE tenant_id='demo' AND client_id=${value.clientId}`,
      ),
    ).toHaveLength(1);
  });
  it("rejects incorrect Hotel IDs and credentials without replacing an existing assignment or stored secret", async () => {
    const a = await property(),
      b = await property(),
      one = body(a),
      two = body(b),
      first = await create(one),
      second = await create(two);
    denied.add("WRONG_HOTEL");
    try {
      expect((await assign(first.json().id, b, "WRONG_HOTEL")).statusCode).toBe(
        403,
      );
      expect(
        (await create({ ...body(await property()), hotelId: "WRONG_HOTEL" }))
          .statusCode,
      ).toBe(403);
    } finally {
      denied.delete("WRONG_HOTEL");
    }
    expect(
      (
        await db.query(
          sql`SELECT connection_id FROM ohip_connection_properties WHERE property_id=${b}`,
        )
      )[0].connection_id,
    ).toBe(second.json().id);
    oauthFails = true;
    try {
      expect((await create(body(await property()))).statusCode).toBe(401);
    } finally {
      oauthFails = false;
    }
    expect(
      decrypt(
        (
          await db.query(
            sql`SELECT encrypted_client_secret FROM ohip_connections WHERE id=${first.json().id}`,
          )
        )[0].encrypted_client_secret,
      ),
    ).toBe(one.clientSecret);
  });
  it("preserves blank edit secrets; rotates shared credentials only after validating every assigned Hotel ID", async () => {
    const a = await property(),
      b = await property(),
      value = body(a),
      id = (await create(value)).json().id;
    await assign(id, b, "HOTEL_B");
    const before = (
      await db.query(sql`SELECT * FROM ohip_connections WHERE id=${id}`)
    )[0];
    expect(
      (await edit(id, { ...value, clientSecret: "", appKey: "" })).statusCode,
    ).toBe(200);
    const unchanged = (
      await db.query(sql`SELECT * FROM ohip_connections WHERE id=${id}`)
    )[0];
    expect(unchanged.encrypted_client_secret).toBe(
      before.encrypted_client_secret,
    );
    expect(unchanged.encrypted_app_key).toBe(before.encrypted_app_key);
    denied.add("HOTEL_B");
    try {
      expect(
        (await edit(id, { ...value, clientSecret: "rotated-secret" }))
          .statusCode,
      ).toBe(403);
    } finally {
      denied.delete("HOTEL_B");
    }
    expect(
      (
        await db.query(
          sql`SELECT encrypted_client_secret FROM ohip_connections WHERE id=${id}`,
        )
      )[0].encrypted_client_secret,
    ).toBe(before.encrypted_client_secret);
    const start = calls.length,
      changed = await edit(id, { ...value, clientSecret: "rotated-secret" });
    expect(changed.statusCode, changed.body).toBe(200);
    const checks = calls.slice(start).filter((c) => !c.url.endsWith("/tokens"));
    expect(checks.map((c) => c.options.headers["x-hotelid"]).sort()).toEqual([
      "HOTEL_A",
      "HOTEL_B",
    ]);
    expect(
      decrypt(
        (
          await db.query(
            sql`SELECT encrypted_client_secret FROM ohip_connections WHERE id=${id}`,
          )
        )[0].encrypted_client_secret,
      ),
    ).toBe("rotated-secret");
  });
  it("enforces property/role isolation and denies edits to shared credentials without access to all assignments", async () => {
    const a = await property("demo", ["demo-admin", "demo-it"]),
      b = await property(),
      value = body(a),
      id = (await create(value)).json().id;
    await assign(id, b, "HOTEL_B");
    const start = calls.length;
    expect((await edit(id, { ...value }, itUser)).statusCode).toBe(403);
    expect((await assign(id, b, "HOTEL_B", itUser)).statusCode).toBe(403);
    expect((await create(body(a), front)).statusCode).toBe(403);
    expect(calls).toHaveLength(start);
    const list = await app.inject({
        url: "/api/ohip-connections",
        headers: itUser,
      }),
      visible = list.json().items.find((c: any) => c.id === id);
    expect(visible.can_edit).toBe(false);
    expect(visible.assigned_properties.map((m: any) => m.property_id)).toEqual([
      a,
    ]);
    expect(list.body).not.toContain(b);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/ohip-connections/${id}/test`,
          headers: itUser,
          payload: { propertyId: b },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("never shares credentials across tenants, including identical credentials; tenant foreign keys protect assignments", async () => {
    const a = await property(),
      b = await property("other", ["other-admin"]),
      value = body(a),
      id = (await create(value)).json().id,
      start = calls.length;
    expect((await assign(id, b, "HOTEL_B", other)).statusCode).toBe(404);
    expect(calls).toHaveLength(start);
    const r = await create(
      { ...value, propertyId: b, hotelId: "HOTEL_B" },
      other,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().id).not.toBe(id);
    const list = await app.inject({
      url: "/api/ohip-connections",
      headers: other,
    });
    expect(list.body).not.toContain(id);
    expect(list.body).not.toContain(a);
    await expect(
      db.query(
        sql`INSERT INTO ohip_connection_properties(id,tenant_id,connection_id,property_id,hotel_id) VALUES (${randomUUID()},'other',${id},${b},'X')`,
      ),
    ).rejects.toThrow();
  });
  it("tests the mapped property and refuses unapproved/unsafe gateways before transport", async () => {
    const p = await property(),
      value = body(p),
      id = (await create(value)).json().id;
    const tested = await app.inject({
      method: "POST",
      url: `/api/ohip-connections/${id}/test`,
      headers: admin,
      payload: { propertyId: p },
    });
    expect(tested.statusCode, tested.body).toBe(200);
    for (const baseUrl of [
      "http://gateway.example.oraclecloud.com",
      "https://127.0.0.1",
      "https://evil.test",
      "https://gateway.example.oraclecloud.com/path",
    ]) {
      const start = calls.length;
      expect(
        (await create({ ...body(await property()), baseUrl })).statusCode,
      ).toBe(400);
      expect(calls).toHaveLength(start);
    }
  });
  it("routes polling through the assigned credentials and property Hotel ID; rejects results after reassignment", async () => {
    const a = await property(),
      b = await property(),
      value = body(a),
      id = (await create(value)).json().id;
    await assign(id, b, "HOTEL_B");
    await db.query(sql`DELETE FROM retry_jobs`);
    await db.query(
      sql`UPDATE connections SET next_poll=now()+interval '1 day'`,
    );
    await db.query(
      sql`UPDATE connections SET next_poll=now() WHERE property_id IN (${a},${b})`,
    );
    const routed: any[] = [];
    const w = worker(db, (c) => ({
      async read() {
        routed.push(c);
        return { items: [], status: 200 };
      },
    }));
    await w.tick();
    expect(routed.map((c) => c.hotel_id).sort()).toEqual([
      "HOTEL_A",
      "HOTEL_B",
    ]);
    expect(
      routed.every(
        (c) =>
          c.connection_id === id &&
          c.tenant_id === "demo" &&
          c.client_id === value.clientId &&
          c.encrypted_secret === null,
      ),
    ).toBe(true);
    await db.query(
      sql`UPDATE connections SET next_poll=now()+interval '1 day'`,
    );
    await db.query(
      sql`UPDATE connections SET next_poll=now() WHERE property_id=${a}`,
    );
    const stale = worker(db, (c) => ({
      async read() {
        expect(c.hotel_id).toBe("HOTEL_A");
        expect((await assign(id, a, "HOTEL_NEW")).statusCode).toBe(200);
        return {
          items: [
            {
              id: "stale",
              confirmation: "STALE",
              guest_name: "Stale",
              arrival: "2026-10-27",
              departure: "2026-10-28",
              status: "Reserved",
              room: null,
              vip: false,
              source: "OHIP polling",
            },
          ],
          status: 200,
        };
      },
    }));
    await stale.tick();
    expect(
      await db.query(
        sql`SELECT 1 FROM reservations WHERE property_id=${a} AND id='stale'`,
      ),
    ).toHaveLength(0);
    expect(
      await db.query(
        sql`SELECT last_error FROM retry_jobs WHERE property_id=${a} AND last_error='connection_changed'`,
      ),
    ).toHaveLength(1);
  });
  it.each([
    ["POST", "/api/ohip-proxy"],
    ["POST", "/api/ohip/request"],
    ["GET", "/api/ohip/unknown"],
    ["POST", "/api/graphql"],
    ["POST", "/api/reservations"],
    ["DELETE", "/api/reservations/123"],
    ["POST", "/api/reservations/123/cancel"],
    ["POST", "/api/reservations/123/check-in"],
    ["POST", "/api/reservations/123/check-out"],
    ["PUT", "/api/guest-profiles/123"],
    ["PUT", "/api/ohip/hsk/v1/hotels/HOTEL_A/rooms/123"],
  ])(
    "blocks direct Oracle/proxy request %s %s with a stable 403 and zero outbound requests",
    async (method, url) => {
      const start = calls.length;
      const result = await app.inject({
        method: method as any,
        url,
        headers: admin,
        ...(method !== "GET"
          ? {
              payload: {
                method: "PUT",
                path: "/reservations",
                operationId: "postReservation",
                query: "mutation { cancel }",
                OHIP_MUTATIONS_ENABLED: true,
              },
            }
          : {}),
      });
      expect(result.statusCode, result.body).toBe(403);
      expect(result.json().error).toBe("OHIP_READ_ONLY_POLICY");
      expect(calls).toHaveLength(start);
    },
  );
  it("denies legacy operational writes on an Oracle property and exposes only approved operation metadata", async () => {
    const p = await property(),
      id = (await create(body(p))).json().id;
    expect(id).toBeTruthy();
    const before = calls.length;
    for (const [method, url, payload] of [
      [
        "POST",
        "/api/tasks",
        { propertyId: p, title: "Must not write", priority: "normal" },
      ],
      [
        "PATCH",
        "/api/rooms/123",
        { propertyId: p, status: "dirty", attention: "Must not write" },
      ],
    ] as const) {
      const result = await app.inject({ method, url, headers: admin, payload });
      expect(result.statusCode, result.body).toBe(403);
      expect(result.json().error).toBe("OHIP_READ_ONLY_POLICY");
    }
    expect(calls).toHaveLength(before);
    const policy = await app.inject({
      url: "/api/ohip-policy",
      headers: admin,
    });
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toMatchObject({
      accessMode: "read_only",
      mutationsEnabled: false,
    });
    expect(Object.keys(policy.json().operations).sort()).toEqual([
      "getReservation",
      "oauth_token",
      "searchHotelReservations",
    ]);
  });
  it("default polling passes the centralized client and never issues Oracle mutations", async () => {
    const p = await property(),
      value = body(p);
    expect((await create(value)).statusCode).toBe(200);
    await db.query(sql`DELETE FROM retry_jobs`);
    await db.query(
      sql`UPDATE connections SET next_poll=now()+interval '1 day'`,
    );
    await db.query(
      sql`UPDATE connections SET next_poll=now() WHERE property_id=${p}`,
    );
    const start = calls.length;
    vi.stubGlobal("fetch", transport);
    try {
      await worker(db).tick();
    } finally {
      vi.unstubAllGlobals();
    }
    const outgoing = calls.slice(start);
    expect(outgoing.length).toBeGreaterThanOrEqual(3);
    for (const request of outgoing) {
      expect(request.options.method).toBe("POST");
      expect(request.options.redirect).toBe("error");
      expect(
        request.url.endsWith("/oauth/v1/tokens") ||
          request.url.endsWith("/rsv/v1/hotels/HOTEL_A/reservations/searches"),
      ).toBe(true);
    }
    const summary = await app.inject({
      url: `/api/overview?propertyId=${p}`,
      headers: admin,
    });
    expect(summary.json().items[0]).toMatchObject({ freshness: "synced" });
    await db.query(
      sql`UPDATE connections SET last_sync=now()-interval '1 hour' WHERE property_id=${p}`,
    );
    const stale = await app.inject({
      url: `/api/overview?propertyId=${p}`,
      headers: admin,
    });
    expect(stale.json().items[0].freshness).toBe("stale");
  }, 30000);
});
