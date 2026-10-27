import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../apps/api/src/app";
import { openDb, migrate, sql, type Database } from "../apps/api/src/db";
import { seed } from "../apps/api/src/seed";
import { worker, backoff, retrySafe } from "../apps/api/src/worker";
import { OhipError, mapReservations } from "../apps/api/src/ohip";
import fixture from "../fixtures/reservations.json";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
let testSchema = "";
let db: Database, app: Awaited<ReturnType<typeof buildApp>>, base: string;
type Auth = { cookie: string; csrf: string; user: any };
let admin: Auth, front: Auth, other: Auth;
let loginCounter = 1;
const password = "Local-demo-test-password!";
async function login(email: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { email, password },
    remoteAddress: "127.0.1." + loginCounter++,
  });
  expect(r.statusCode).toBe(200);
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join(";");
  const me = await app.inject({ url: "/api/me", headers: { cookie } });
  return { cookie, csrf: me.json().csrf, user: me.json() };
}
function headers(a: Auth) {
  return { cookie: a.cookie, "x-csrf-token": a.csrf };
}
beforeAll(async () => {
  process.env.APP_ORIGIN = "http://localhost:5173";
  const testUrl = process.env.TEST_DATABASE_URL;
  if (testUrl) {
    const url = new URL(testUrl);
    if (
      !url.pathname.endsWith("_test") ||
      !["localhost", "127.0.0.1"].includes(url.hostname)
    )
      throw Error(
        "TEST_DATABASE_URL must target a local database ending in _test",
      );
    testSchema = "test_" + randomUUID().replaceAll("-", "");
    url.searchParams.set("options", "-csearch_path=" + testSchema);
    db = await openDb(false, url.toString());
    await db.query(sql`CREATE SCHEMA ${sql.identifier(testSchema)}`);
  } else db = await openDb(true);
  await migrate(db);
  await seed(db, password);
  app = await buildApp(db);
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  admin = await login("admin@demo.local");
  front = await login("frontoffice@demo.local");
  other = await login("admin@other.local");
}, 60000);
afterAll(async () => {
  await app?.close();
  if (testSchema && db)
    await db.query(sql`DROP SCHEMA ${sql.identifier(testSchema)} CASCADE`);
  await db?.close();
});
describe("authentication and scope", () => {
  it("requires session and rejects incorrect credentials", async () => {
    expect((await app.inject("/api/me")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          payload: { email: "admin@demo.local", password: "wrong" },
        })
      ).statusCode,
    ).toBe(401);
  });
  it("sets HttpOnly SameSite cookies and does not return hashes or credentials", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { email: "manager@demo.local", password },
    });
    expect(r.headers["set-cookie"]).toContain("HttpOnly");
    expect(r.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(admin.user).not.toHaveProperty("tokenHash");
    expect(admin.user).not.toHaveProperty("password_hash");
  });
  it("denies property and tenant overrides even for group administrators", async () => {
    for (const [a, p] of [
      [admin, "other-1"],
      [front, "demo-2"],
      [other, "demo-1"],
    ] as const) {
      for (const path of [
        "reservations",
        "tasks",
        "rooms",
        "assignees",
        "overview",
      ])
        expect(
          (
            await app.inject({
              url: `/api/${path}?propertyId=${p}`,
              headers: headers(a),
            })
          ).statusCode,
        ).toBe(403);
    }
  });
  it("filters command center server-side to granted properties", async () => {
    const a = (
      await app.inject({ url: "/api/overview", headers: headers(admin) })
    ).json();
    const f = (
      await app.inject({ url: "/api/overview", headers: headers(front) })
    ).json();
    expect(a.items).toHaveLength(3);
    expect(f.items).toHaveLength(1);
    expect(a.items.every((r: any) => r.property.id.startsWith("demo-"))).toBe(
      true,
    );
    expect(a.items[0].arrivals).toBeGreaterThan(0);
  });
  it("validates date filters and pagination", async () => {
    expect(
      (
        await app.inject({
          url: "/api/overview?date=nope",
          headers: headers(admin),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: "/api/reservations?propertyId=demo-1&limit=500",
          headers: headers(admin),
        })
      ).statusCode,
    ).toBe(400);
    const a = (
      await app.inject({
        url: "/api/reservations?propertyId=demo-1&limit=3&page=1",
        headers: headers(admin),
      })
    ).json();
    const b = (
      await app.inject({
        url: "/api/reservations?propertyId=demo-1&limit=3&page=2",
        headers: headers(admin),
      })
    ).json();
    expect(a.items).toHaveLength(3);
    expect(b.items).toHaveLength(3);
    expect(
      a.items
        .map((r: any) => r.id)
        .filter((id: string) => b.items.some((r: any) => r.id === id)),
    ).toHaveLength(0);
  });
  it("searches confirmation/name and handles empty results", async () => {
    for (const q of ["DEMO-81000", "Alex"]) {
      const r = (
        await app.inject({
          url: "/api/reservations?propertyId=demo-1&q=" + q,
          headers: headers(admin),
        })
      ).json();
      expect(r.total).toBeGreaterThan(0);
    }
    const r = (
      await app.inject({
        url: "/api/reservations?propertyId=demo-1&q=missing-record",
        headers: headers(admin),
      })
    ).json();
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });
  it("checks detail scope despite colliding reservation IDs", async () => {
    expect(
      (
        await app.inject({
          url: "/api/reservations/res-0?propertyId=other-1",
          headers: headers(admin),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/reservations/res-0?propertyId=demo-1",
          headers: headers(admin),
        })
      ).json().source,
    ).toBe("DEMO");
  });
  it("requires CSRF and rejects foreign origins", async () => {
    const payload = { propertyId: "demo-1", title: "Test", priority: "normal" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          headers: { cookie: admin.cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/tasks",
          headers: { ...headers(admin), origin: "https://evil.test" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
  });
  it("enforces role permissions on guest, integration, and admin APIs", async () => {
    const hk = await login("housekeeping@demo.local");
    expect(
      (
        await app.inject({
          url: "/api/reservations?propertyId=demo-1",
          headers: headers(hk),
        })
      ).statusCode,
    ).toBe(403);
    for (const path of [
      "/api/connections",
      "/api/retry-jobs",
      "/api/admin",
      "/api/developer",
    ])
      expect(
        (await app.inject({ url: path, headers: headers(front) })).statusCode,
      ).toBe(403);
  });
  it("supports valid zero-property and zero-record states", async () => {
    const p = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: headers(admin),
      payload: {
        name: "Empty",
        email: "empty@demo.local",
        password,
        role: "front_office",
        properties: [],
      },
    });
    expect(p.statusCode).toBe(200);
    const empty = await login("empty@demo.local");
    expect(empty.user.properties).toEqual([]);
    expect(
      (
        await app.inject({ url: "/api/overview", headers: headers(empty) })
      ).json().items,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          url: "/api/overview?date=2030-01-01",
          headers: headers(admin),
        })
      ).json().items[0].arrivals,
    ).toBe(0);
  });
});
describe("mutations and recovery", () => {
  it("provisions an isolated empty tenant, switches only authorized memberships, and rotates CSRF", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/tenants",
          headers: headers(admin),
          payload: { name: "Denied", hostname: "denied.localhost" },
        })
      ).statusCode,
    ).toBe(403);
    const platform = await login("platform@demo.local");
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/tenants",
      headers: headers(platform),
      payload: { name: "New empty workspace", hostname: "new.localhost" },
    });
    expect(created.statusCode).toBe(200);
    const tenantId = created.json().id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/switch-tenant",
          headers: headers(platform),
          payload: { tenantId: "other" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/switch-tenant",
          headers: headers(platform),
          payload: { tenantId },
        })
      ).statusCode,
    ).toBe(200);
    const me = (
      await app.inject({ url: "/api/me", headers: { cookie: platform.cookie } })
    ).json();
    expect(me.tenantId).toBe(tenantId);
    expect(me.properties).toEqual([]);
    expect(me.csrf).not.toBe(platform.csrf);
    expect(
      (
        await app.inject({
          url: "/api/overview",
          headers: { cookie: platform.cookie },
        })
      ).json().items,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          url: "/api/reservations?propertyId=demo-1",
          headers: { cookie: platform.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("updates membership permissions and revokes previous sessions", async () => {
    const auth = await login("empty@demo.local");
    const r = await app.inject({
      method: "PATCH",
      url: "/api/admin/users/" + auth.user.id,
      headers: headers(admin),
      payload: { role: "housekeeping", properties: ["demo-1"] },
    });
    expect(r.statusCode).toBe(200);
    expect(
      (await app.inject({ url: "/api/me", headers: { cookie: auth.cookie } }))
        .statusCode,
    ).toBe(401);
    const fresh = await login("empty@demo.local");
    expect(fresh.user.role).toBe("housekeeping");
    expect(fresh.user.properties).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/users/" + fresh.user.id,
          headers: headers(admin),
          payload: { role: "group_admin", properties: ["other-1"] },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("documents authenticated routes and their request schemas in OpenAPI", async () => {
    const schema = app.swagger();
    expect(
      schema.paths?.["/api/reservations"]?.get?.parameters?.length,
    ).toBeGreaterThan(0);
    expect(schema.paths?.["/api/tasks"]?.post).toHaveProperty("requestBody");
  });
  it("assigns and acknowledges tasks, validates target grants, writes audits", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: headers(admin),
      payload: {
        propertyId: "demo-1",
        title: "Test welcome",
        priority: "high",
      },
    });
    const tid = create.json().id;
    expect(create.statusCode).toBe(200);
    const payload = {
      propertyId: "demo-1",
      status: "acknowledged",
      assignee: "demo-frontoffice",
    };
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/tasks/" + tid,
          headers: headers(admin),
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/tasks/" + tid,
          headers: headers(admin),
          payload: { ...payload, assignee: "other-frontoffice" },
        })
      ).statusCode,
    ).toBe(400);
    const audit = (
      await app.inject({ url: "/api/audit-logs", headers: headers(admin) })
    ).json();
    expect(
      audit.items.some(
        (a: any) => a.target === tid && a.action === "task.update",
      ),
    ).toBe(true);
  });
  it("prevents room mutation across properties", async () => {
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/rooms/201",
          headers: headers(front),
          payload: { propertyId: "demo-1", status: "clean", attention: "" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/rooms/201",
          headers: headers(admin),
          payload: { propertyId: "other-1", status: "clean", attention: "" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("redacts connection secrets and rejects unapproved gateways", async () => {
    expect(
      (
        await app.inject({
          url: "/api/connections?propertyId=demo-1",
          headers: headers(admin),
        })
      ).body,
    ).not.toContain("encrypted_secret");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/connections",
          headers: headers(admin),
          payload: {
            propertyId: "demo-1",
            mode: "real",
            environment: "sandbox",
            gateway: "https://127.0.0.1",
            hotelId: "A",
            enterpriseId: "E",
            clientId: "C",
            clientSecret: "S",
            applicationKey: "K",
          },
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });
  it("only retries scoped read jobs with permission and audit", async () => {
    const jid = (
      await db.query(
        sql`SELECT id FROM retry_jobs WHERE tenant_id='demo' LIMIT 1`,
      )
    )[0].id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/retry-jobs/${jid}/retry`,
          headers: headers(front),
          payload: { propertyId: "demo-2" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/retry-jobs/${jid}/retry`,
          headers: headers(admin),
          payload: { propertyId: "other-2" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/retry-jobs/${jid}/retry`,
          headers: headers(admin),
          payload: { propertyId: "demo-2" },
        })
      ).statusCode,
    ).toBe(200);
    expect(retrySafe("reservation_poll")).toBe(true);
    expect(retrySafe("check_in")).toBe(false);
  });
  it("bounds exponential backoff", () => {
    expect(backoff(1, 0)).toBe(2000);
    expect(backoff(2, 0)).toBe(4000);
    expect(backoff(999, 0)).toBe(300000);
  });
  it("persists idempotent poll results and checkpoints", async () => {
    const items = mapReservations(fixture);
    const w = worker(db, () => ({
      read: async () => ({ items, status: 200 }),
    }));
    await w.tick();
    const before = (
      await db.query(
        sql`SELECT updated_at FROM reservations WHERE tenant_id='demo' AND property_id='demo-1' AND id='98765'`,
      )
    )[0];
    expect(before).toBeDefined();
    await db.query(sql`UPDATE connections SET next_poll=now()`);
    await w.tick();
    const after = (
      await db.query(
        sql`SELECT updated_at FROM reservations WHERE tenant_id='demo' AND property_id='demo-1' AND id='98765'`,
      )
    )[0];
    expect(after.updated_at).toEqual(before.updated_at);
    const c = (
      await db.query(
        sql`SELECT checkpoint FROM connections WHERE property_id='demo-1'`,
      )
    )[0];
    expect(c.checkpoint.strategy).toBe("bounded_daily_reconciliation");
  });
  it("moves exhausted transient failures to dead letters and sanitizes errors", async () => {
    await db.query(sql`UPDATE connections SET next_poll=now()`);
    const w = worker(db, () => ({
      read: async () => {
        throw new OhipError(503, "upstream");
      },
    }));
    await w.tick();
    let jobs = await db.query(
      sql`SELECT * FROM retry_jobs WHERE state='queued'`,
    );
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].attempts).toBe(1);
    expect(new Date(jobs[0].next_at).getTime()).toBeGreaterThan(Date.now());
    await db.query(
      sql`UPDATE retry_jobs SET attempts=4,next_at=now() WHERE state='queued'`,
    );
    await w.tick();
    jobs = await db.query(sql`SELECT * FROM retry_jobs WHERE state='dead'`);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].attempts).toBe(5);
    expect(jobs[0].last_error).toBe("upstream");
  });
  it("does not allow a group admin to create a platform admin", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/users",
          headers: headers(admin),
          payload: {
            name: "Escalate",
            email: "e@demo.local",
            password,
            role: "platform_admin",
            properties: [],
          },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("prevents internal codename in branding", async () => {
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/branding",
          headers: headers(admin),
          payload: {
            appName: "Heisenberg",
            primary: "#112233",
            logo: "",
            favicon: "/favicon.svg",
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});
async function socket(auth: Auth, after = 0, origin = "http://localhost:5173") {
  const ws = new WebSocket(
    base.replace("http:", "ws:") + `/api/ws?after=${after}&csrf=${auth.csrf}`,
    { headers: { cookie: auth.cookie, origin } },
  );
  const messages: any[] = [];
  ws.on("message", (b) => messages.push(JSON.parse(b.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages };
}
async function until(test: () => boolean) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > 6000)
      throw Error("Timed out waiting for websocket");
    await new Promise((r) => setTimeout(r, 25));
  }
}
describe("authenticated websocket recovery", () => {
  it("does not deliver events across tenants or unauthorized properties; replays after reconnect", async () => {
    const a = await socket(front),
      b = await socket(other);
    try {
      await until(() => a.messages.some((m) => m.topic === "heartbeat"));
      const cursor = a.messages.at(-1).seq;
      a.messages.length = 0;
      b.messages.length = 0;
      await db.query(
        sql`INSERT INTO change_events(tenant_id,property_id,topic) VALUES ('other','other-1','tasks'),('demo','demo-2','tasks'),('demo','demo-1','tasks')`,
      );
      await until(
        () =>
          a.messages.some((m) => m.topic === "tasks") &&
          b.messages.some((m) => m.topic === "tasks"),
      );
      expect(
        a.messages.filter((m) => m.topic === "tasks").map((m) => m.propertyId),
      ).toEqual(["demo-1"]);
      expect(
        b.messages.filter((m) => m.topic === "tasks").map((m) => m.propertyId),
      ).toEqual(["other-1"]);
      expect(JSON.stringify(a.messages)).not.toContain("guest_name");
      a.ws.close();
      const recovered = await socket(front, cursor);
      try {
        await until(() => recovered.messages.some((m) => m.topic === "tasks"));
        expect(recovered.messages.some((m) => m.propertyId === "demo-1")).toBe(
          true,
        );
        expect(recovered.messages.some((m) => m.propertyId === "demo-2")).toBe(
          false,
        );
      } finally {
        recovered.ws.close();
      }
    } finally {
      a.ws.close();
      b.ws.close();
    }
  });
  it("rejects foreign-origin websocket connections", async () => {
    const s = await socket(front, 0, "https://evil.test");
    const code = await new Promise<number>((resolve) =>
      s.ws.on("close", resolve),
    );
    expect(code).toBe(1008);
  });
  it("revokes an established socket on logout", async () => {
    const auth = await login("manager@demo.local");
    const s = await socket(auth);
    await until(() => s.messages.some((m) => m.topic === "heartbeat"));
    const closed = new Promise<number>((resolve) => s.ws.on("close", resolve));
    await app.inject({
      method: "POST",
      url: "/api/logout",
      headers: headers(auth),
      payload: {},
    });
    expect(await closed).toBe(1008);
    expect(
      (await app.inject({ url: "/api/me", headers: headers(auth) })).statusCode,
    ).toBe(401);
  });
});
