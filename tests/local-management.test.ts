import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { buildApp } from "../apps/api/src/app";
import { migrate, sql, type Database } from "../apps/api/src/db";
import { isolatedDatabase } from "./isolated-database";
import { seed } from "../apps/api/src/seed";
let db: Database,
  app: Awaited<ReturnType<typeof buildApp>>,
  close: () => Promise<void>;
let admin: any, other: any;
const password = "local-crud-regression-password";
const transport = vi.fn(async () => Response.json({}));
async function login(email: string) {
  const r = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { email, password },
  });
  expect(r.statusCode, r.body).toBe(200);
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join(";");
  const me = await app.inject({ url: "/api/me", headers: { cookie } });
  return { cookie, "x-csrf-token": me.json().csrf };
}
const write = (
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  payload: any = {},
  headers = admin,
) => app.inject({ method, url: "/api" + path, payload, headers });
beforeAll(async () => {
  const isolated = await isolatedDatabase();
  db = isolated.db;
  close = isolated.close;
  await migrate(db);
  await seed(db, password);
  app = await buildApp(db, { ohipTransport: transport });
  admin = await login("admin@demo.local");
  other = await login("admin@other.local");
}, 60000);
afterAll(async () => {
  await app?.close();
  await close?.();
});
it("creates, edits, archives tenant/organization/property locally and retains audit history", async () => {
  await db.query(
    sql`UPDATE memberships SET role='platform_admin' WHERE tenant_id='demo' AND user_id='demo-admin'`,
  );
  const tenant = await write("POST", "/admin/tenants", {
    name: "Isolated",
    hostname: "crud.localhost",
  });
  expect(tenant.statusCode, tenant.body).toBe(200);
  // Cross-tenant writes stay denied even for platform administrators.
  expect(
    (
      await write("PATCH", `/admin/tenants/${tenant.json().id}`, {
        name: "Denied",
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await write("PATCH", "/admin/tenants/demo", { name: "Updated tenant" }))
      .statusCode,
  ).toBe(200);
  const org = await write("POST", "/admin/organizations", {
      name: "Local org",
    }),
    oid = org.json().id;
  expect(org.statusCode, org.body).toBe(200);
  expect(
    (
      await write("PATCH", `/admin/organizations/${oid}`, {
        name: "Edited org",
      })
    ).statusCode,
  ).toBe(200);
  const p = await write("POST", "/admin/properties", {
      name: "Empty property",
      organizationId: oid,
      timezone: "Asia/Jakarta",
    }),
    pid = p.json().id;
  expect(p.statusCode, p.body).toBe(200);
  expect(
    (await write("DELETE", `/admin/organizations/${oid}`)).statusCode,
  ).toBe(409);
  expect(
    (
      await write("PATCH", `/admin/properties/${pid}`, {
        name: "Updated property",
        organizationId: oid,
        timezone: "UTC",
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await write("PATCH", `/admin/properties/${pid}`, {
        name: "Bad timezone",
        organizationId: oid,
        timezone: "Not/AZone",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await write("PATCH", `/admin/properties/${pid}`, {
        name: "Cross tenant",
        organizationId: "other-group",
        timezone: "UTC",
      })
    ).statusCode,
  ).toBe(403);
  const archived = await write("DELETE", `/admin/properties/${pid}`);
  expect(archived.statusCode, archived.body).toBe(200);
  expect(
    (await write("DELETE", `/admin/organizations/${oid}`)).statusCode,
  ).toBe(200);
  expect(
    (
      await write("POST", "/admin/properties", {
        name: "Denied",
        organizationId: oid,
        timezone: "UTC",
      })
    ).statusCode,
  ).toBe(403);
  const list = await app.inject({ url: "/api/admin", headers: admin });
  expect(list.json().properties.some((p: any) => p.id === pid)).toBe(false);
  expect(
    await db.query(sql`SELECT * FROM properties WHERE id=${pid}`),
  ).toHaveLength(1);
  expect(
    await db.query(sql`SELECT * FROM audit_logs WHERE target=${pid}`),
  ).toHaveLength(3);
  expect((await write("DELETE", "/admin/tenants/demo")).statusCode).toBe(409);
  expect(transport).not.toHaveBeenCalled();
});
it("blocks property deletion with connections, active jobs, tasks and other user assignments", async () => {
  expect((await write("DELETE", "/admin/properties/demo-1")).statusCode).toBe(
    409,
  );
  for (const dependency of ["job", "task", "grant"]) {
    const p = await write("POST", "/admin/properties", {
        name: dependency,
        organizationId: "demo-group",
        timezone: "UTC",
      }),
      id = p.json().id;
    if (dependency === "job")
      await db.query(
        sql`INSERT INTO retry_jobs(id,tenant_id,property_id,operation,idempotency_key,state) VALUES (${id},'demo',${id},'reservation_poll',${id},'queued')`,
      );
    if (dependency === "task")
      await db.query(
        sql`INSERT INTO tasks(id,tenant_id,property_id,title,priority) VALUES (${id},'demo',${id},'Active task','normal')`,
      );
    if (dependency === "grant")
      await db.query(
        sql`INSERT INTO property_grants VALUES ('demo','demo-it',${id})`,
      );
    expect((await write("DELETE", `/admin/properties/${id}`)).statusCode).toBe(
      409,
    );
  }
});
it("creates, edits and archives memberships with last-admin/self and tenant protection", async () => {
  const r = await write("POST", "/admin/users", {
      name: "Temporary",
      email: "temporary@local.test",
      password,
      role: "front_office",
      properties: [],
    }),
    uid = r.json().id;
  expect(r.statusCode, r.body).toBe(200);
  expect(
    (
      await write("PATCH", `/admin/users/${uid}`, {
        role: "it",
        properties: ["demo-1"],
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await write("DELETE", `/admin/users/${uid}`, {}, other)).statusCode,
  ).toBe(404);
  expect((await write("DELETE", "/admin/users/demo-admin")).statusCode).toBe(
    409,
  );
  const archived = await write("DELETE", `/admin/users/${uid}`);
  expect(archived.statusCode, archived.body).toBe(200);
  const denied = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { email: "temporary@local.test", password },
  });
  expect(denied.statusCode).toBe(401);
  expect(
    (
      await write("PATCH", `/admin/users/${uid}`, {
        role: "it",
        properties: [],
      })
    ).statusCode,
  ).toBe(404);
  expect(
    await db.query(sql`SELECT * FROM audit_logs WHERE target=${uid}`),
  ).toHaveLength(3);
  expect(
    await db.query(sql`SELECT * FROM memberships WHERE user_id=${uid}`),
  ).toHaveLength(1);
  expect(transport).not.toHaveBeenCalled();
});
it("denies cross-tenant writes and non-administrator local CRUD", async () => {
  expect(
    (await write("PATCH", "/admin/organizations/other-group", { name: "No" }))
      .statusCode,
  ).toBe(404);
  expect((await write("DELETE", "/admin/properties/other-1")).statusCode).toBe(
    403,
  );
  const front = await login("frontoffice@demo.local");
  expect(
    (await write("POST", "/admin/organizations", { name: "No" }, front))
      .statusCode,
  ).toBe(403);
  expect(
    (await write("DELETE", "/admin/users/demo-it", {}, front)).statusCode,
  ).toBe(403);
});
it("archives an empty tenant while preserving audit history and revoking its sessions", async () => {
  const provision = await write("POST", "/admin/tenants", {
      name: "Disposable workspace",
      hostname: "archive.localhost",
    }),
    tid = provision.json().id;
  expect(provision.statusCode, provision.body).toBe(200);
  const session = await login("admin@demo.local");
  expect(
    (await write("POST", "/switch-tenant", { tenantId: tid }, session))
      .statusCode,
  ).toBe(200);
  const me = await app.inject({
    url: "/api/me",
    headers: { cookie: session.cookie },
  });
  const tenantHeaders = {
    cookie: session.cookie,
    "x-csrf-token": me.json().csrf,
  };
  const deleted = await write(
    "DELETE",
    `/admin/tenants/${tid}`,
    {},
    tenantHeaders,
  );
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(
    (await app.inject({ url: "/api/me", headers: tenantHeaders })).statusCode,
  ).toBe(401);
  expect(
    await db.query(sql`SELECT * FROM tenants WHERE id=${tid}`),
  ).toHaveLength(1);
  expect(
    await db.query(
      sql`SELECT * FROM audit_logs WHERE tenant_id=${tid} AND action='tenants.archive'`,
    ),
  ).toHaveLength(1);
});
it("saves and resets internal configuration with tenant scope and audit events", async () => {
  expect((await write("DELETE", "/branding", {}, other)).statusCode).toBe(200);
  expect(
    await db.query(sql`SELECT * FROM branding_profiles WHERE tenant_id='demo'`),
  ).toHaveLength(1);
  expect((await write("DELETE", "/branding")).statusCode).toBe(200);
  expect(
    await db.query(
      sql`SELECT * FROM audit_logs WHERE tenant_id='demo' AND action='branding.reset'`,
    ),
  ).toHaveLength(1);
  expect(transport).not.toHaveBeenCalled();
});
