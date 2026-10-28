import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Database } from "./db.js";
import { hashToken, verifyPassword, hashPassword } from "./security.js";
import { realtime, appendEvent, type Principal } from "./realtime.js";
import {
  canAdmin,
  canGuests,
  canIntegrate,
  roles,
} from "@hospitality/contracts";
import { OhipError } from "./ohip.js";
import { registerConnectionCenter } from "./connections.js";
import {
  blockedOracleApi,
  OhipReadOnlyError,
  APPROVED_OHIP_OPERATIONS,
} from "./ohip-policy.js";
import { documentRoutes } from "./openapi.js";
declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}
const id = z.string().min(1).max(100);
const date = z.iso.date();
const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
export async function buildApp(
  db: Database,
  options: { ohipTransport?: typeof fetch } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 65536, trustProxy: false });
  app.addHook("onRequest", async (req) => {
    if (blockedOracleApi(req.method, req.url)) throw new OhipReadOnlyError();
  });
  const rt = realtime(db);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "https:", "data:"],
        connectSrc: ["'self'", "ws:", "wss:"],
      },
    },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 2048 } });
  await app.register(swagger, {
    openapi: {
      info: { title: "Hospitality Operations API", version: "1.0.0" },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "session" },
        },
      },
      security: [{ session: [] }],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { supportedSubmitMethods: ["get"] },
  });
  documentRoutes(app);
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error & { statusCode?: number };
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: "Invalid request",
        details: error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      });
    if (error instanceof OhipError)
      return reply
        .code(error.status >= 400 && error.status < 500 ? error.status : 502)
        .send({ error: error.classification });
    const databaseCode = (e.cause as { code?: string } | undefined)?.code;
    if (databaseCode === "23505")
      return reply
        .code(409)
        .send({ error: "Record already exists or an active job conflicts" });
    if (databaseCode === "23503")
      return reply
        .code(400)
        .send({ error: "Referenced record is unavailable" });
    const code = e.statusCode || 500;
    return reply
      .code(code)
      .send({ error: code >= 500 ? "Internal service error" : e.message });
  });
  async function identity(token: string | undefined) {
    if (!token) throw fail(401, "Sign in required");
    const s = (
      await db.query(
        sql`SELECT s.*,m.role,u.developer FROM sessions s JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id JOIN users u ON u.id=s.user_id WHERE token_hash=${hashToken(token)} AND expires_at>now()`,
      )
    )[0];
    if (!s) throw fail(401, "Session expired");
    const grants = await db.query(
      sql`SELECT property_id FROM property_grants WHERE tenant_id=${s.tenant_id} AND user_id=${s.user_id}`,
    );
    return {
      id: s.user_id,
      tenantId: s.tenant_id,
      role: s.role,
      developer: s.developer,
      csrf: s.csrf,
      properties: grants.map((g) => g.property_id),
      expiresAt: new Date(s.expires_at).getTime(),
      tokenHash: hashToken(token),
    } as Principal;
  }
  app.addHook("preHandler", async (req) => {
    const path = req.url.split("?")[0];
    if (
      !req.url.startsWith("/api/") ||
      (req.method === "POST" && path === "/api/login") ||
      (req.method === "GET" && ["/api/branding", "/api/health"].includes(path))
    )
      return;
    req.principal = await identity(req.cookies.session);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (
        req.headers.origin !== process.env.APP_ORIGIN &&
        req.headers.origin !== undefined
      )
        throw fail(403, "Origin rejected");
      if (req.headers["x-csrf-token"] !== req.principal.csrf)
        throw fail(403, "CSRF token required");
    }
  });
  function property(user: Principal, value: unknown) {
    const p = id.parse(value);
    if (!user.properties.includes(p)) throw fail(403, "Property access denied");
    return p;
  }
  function scope(user: Principal) {
    return user.properties.length
      ? sql.join(
          user.properties.map((p) => sql`${p}`),
          sql`, `,
        )
      : sql`NULL`;
  }
  function requireRole(condition: boolean) {
    if (!condition) throw fail(403, "Permission denied");
  }
  async function audit(
    tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
    u: Principal,
    p: string | null,
    action: string,
    target: string,
  ) {
    await tx.execute(
      sql`INSERT INTO audit_logs VALUES (${randomUUID()},${u.tenantId},${p},${u.id},${action},${target},now())`,
    );
  }
  async function localDemoOnly(u: Principal, p: string) {
    if (
      (
        await db.query(
          sql`SELECT 1 FROM connections WHERE tenant_id=${u.tenantId} AND property_id=${p} AND mode='real' UNION ALL SELECT 1 FROM ohip_connection_properties WHERE tenant_id=${u.tenantId} AND property_id=${p} LIMIT 1`,
        )
      ).length
    )
      throw new OhipReadOnlyError();
  }
  app.get("/api/ohip-policy", async (req) => {
    requireRole(canIntegrate(req.principal.role));
    return {
      accessMode: "read_only",
      mutationsEnabled: false,
      operations: APPROVED_OHIP_OPERATIONS,
    };
  });
  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/branding", async (req) => {
    const host = req.hostname;
    const b = (
      await db.query(
        sql`SELECT b.* FROM branding_profiles b JOIN app_instances a ON a.tenant_id=b.tenant_id WHERE a.hostname=${host}`,
      )
    )[0];
    return b
      ? {
          appName: b.app_name,
          primary: b.primary_color,
          logo: b.logo,
          favicon: b.favicon,
        }
      : {
          appName: "Hospitality Operations",
          primary: "#17675d",
          logo: "",
          favicon: "/favicon.svg",
        };
  });
  app.post(
    "/api/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          additionalProperties: false,
          properties: {
            email: { type: "string", maxLength: 254 },
            password: { type: "string", maxLength: 256 },
            tenantId: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      if (req.headers.origin && req.headers.origin !== process.env.APP_ORIGIN)
        throw fail(403, "Origin rejected");
      const b = z
        .object({
          email: z.email(),
          password: z.string().min(1).max(256),
          tenantId: id.optional(),
        })
        .parse(req.body);
      const users = await db.query(
        sql`SELECT u.*,m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE lower(u.email)=${b.email.toLowerCase()} ${b.tenantId ? sql`AND m.tenant_id=${b.tenantId}` : sql``} ORDER BY m.tenant_id`,
      );
      const u = users[0];
      if (!u || !(await verifyPassword(b.password, u.password_hash)))
        throw fail(401, "Invalid credentials");
      const token = randomBytes(32).toString("hex"),
        csrf = randomBytes(24).toString("hex");
      await db.query(
        sql`INSERT INTO sessions VALUES (${hashToken(token)},${u.id},${u.tenant_id},${csrf},now()+interval '8 hours')`,
      );
      reply.setCookie("session", token, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === "true",
        sameSite: "strict",
        path: "/",
        maxAge: 28800,
      });
      return { ok: true };
    },
  );
  app.post("/api/logout", async (req, reply) => {
    await db.query(
      sql`DELETE FROM sessions WHERE token_hash=${hashToken(req.cookies.session!)}`,
    );
    reply.clearCookie("session", { path: "/" });
    return { ok: true };
  });
  app.post("/api/switch-tenant", async (req) => {
    const u = req.principal,
      b = z.object({ tenantId: id }).parse(req.body);
    if (
      !(
        await db.query(
          sql`SELECT 1 FROM memberships WHERE user_id=${u.id} AND tenant_id=${b.tenantId}`,
        )
      ).length
    )
      throw fail(403, "Workspace access denied");
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`UPDATE sessions SET tenant_id=${b.tenantId},csrf=${randomBytes(24).toString("hex")} WHERE token_hash=${u.tokenHash}`,
      );
      await audit(tx, u, null, "workspace.switch", b.tenantId);
    });
    return { ok: true };
  });
  app.get("/api/me", async (req) => {
    const u = req.principal;
    const user = (
      await db.query(sql`SELECT name FROM users WHERE id=${u.id}`)
    )[0];
    const branding = (
      await db.query(
        sql`SELECT * FROM branding_profiles WHERE tenant_id=${u.tenantId}`,
      )
    )[0];
    return {
      id: u.id,
      tenantId: u.tenantId,
      role: u.role,
      developer: u.developer,
      csrf: u.csrf,
      name: user.name,
      tenants: await db.query(
        sql`SELECT t.id,t.name FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=${u.id} ORDER BY t.name`,
      ),
      properties: await db.query(
        sql`SELECT id,name,organization_id,timezone FROM properties WHERE tenant_id=${u.tenantId} AND id IN (${scope(u)}) ORDER BY name`,
      ),
      branding: {
        appName: branding?.app_name || "Hospitality Operations",
        primary: branding?.primary_color || "#17675d",
        logo: branding?.logo || "",
        favicon: branding?.favicon || "/favicon.svg",
      },
    };
  });
  app.get("/api/ws", { websocket: true }, async (socket, req) => {
    try {
      if (req.headers.origin !== process.env.APP_ORIGIN)
        throw fail(403, "Origin rejected");
      const u = await identity(req.cookies.session);
      const q = z
        .object({
          after: z.coerce.number().int().nonnegative().default(0),
          csrf: z.string(),
        })
        .parse(req.query);
      if (q.csrf !== u.csrf) throw fail(403, "CSRF rejected");
      await rt.add(socket, u, q.after);
    } catch {
      socket.close(1008, "Unauthorized");
    }
  });
  app.get("/api/overview", async (req) => {
    const u = req.principal,
      q = z
        .object({
          date: date.optional(),
          organizationId: id.optional(),
          propertyId: id.optional(),
        })
        .parse(req.query);
    if (q.propertyId) property(u, q.propertyId);
    const rows =
      await db.query(sql`SELECT p.id,p.name,p.organization_id,p.timezone,c.status AS connection,c.last_sync AS "lastSync",c.mode AS source,
      CASE WHEN c.mode='demo' THEN 'demo' WHEN c.last_sync IS NULL THEN 'not_synced' WHEN c.status!='connected' OR c.last_sync<now()-${Math.max(180000, (Number(process.env.POLL_INTERVAL_MS) || 60000) * 3)}*interval '1 millisecond' THEN 'stale' ELSE 'synced' END AS freshness,
      (SELECT count(*)::int FROM reservations r WHERE r.tenant_id=p.tenant_id AND r.property_id=p.id AND r.arrival=coalesce(${q.date || null}::date,(now() AT TIME ZONE p.timezone)::date) AND r.status NOT IN ('Cancelled','NoShow')) AS arrivals,
      (SELECT count(*)::int FROM reservations r WHERE r.tenant_id=p.tenant_id AND r.property_id=p.id AND r.departure=coalesce(${q.date || null}::date,(now() AT TIME ZONE p.timezone)::date) AND r.status NOT IN ('Cancelled','NoShow')) AS departures,
      (SELECT count(*)::int FROM reservations r WHERE r.tenant_id=p.tenant_id AND r.property_id=p.id AND r.arrival<=coalesce(${q.date || null}::date,(now() AT TIME ZONE p.timezone)::date) AND r.departure>=coalesce(${q.date || null}::date,(now() AT TIME ZONE p.timezone)::date) AND r.status IN ('InHouse','DueOut')) AS "inHouse",
      (SELECT count(*)::int FROM reservations r WHERE r.tenant_id=p.tenant_id AND r.property_id=p.id AND r.vip AND r.arrival=coalesce(${q.date || null}::date,(now() AT TIME ZONE p.timezone)::date)) AS vip,
      (SELECT count(*)::int FROM tasks t WHERE t.tenant_id=p.tenant_id AND t.property_id=p.id AND t.status!='done') AS pending,
      (SELECT count(*)::int FROM rooms r WHERE r.tenant_id=p.tenant_id AND r.property_id=p.id AND r.attention!='') AS attention,
      (SELECT count(*)::int FROM reservations r WHERE r.tenant_id=p.tenant_id AND r.property_id=p.id AND (r.updated_at AT TIME ZONE p.timezone)::date=coalesce(${q.date || null}::date,(now() AT TIME ZONE p.timezone)::date)) AS changes
      FROM properties p LEFT JOIN connections c ON c.tenant_id=p.tenant_id AND c.property_id=p.id WHERE p.tenant_id=${u.tenantId} AND p.id IN (${scope(u)}) ${q.organizationId ? sql`AND p.organization_id=${q.organizationId}` : sql``} ${q.propertyId ? sql`AND p.id=${q.propertyId}` : sql``} ORDER BY p.name`);
    return {
      items: rows.map(({ id, name, organization_id, timezone, ...r }) => ({
        ...r,
        property: { id, name, organization_id, timezone },
      })),
      asOf: new Date().toISOString(),
      note: "Counts reflect local read model. Historical snapshots are not available.",
    };
  });
  app.get("/api/reservations", async (req) => {
    const u = req.principal;
    requireRole(canGuests(u.role));
    const q = pagination
      .extend({
        propertyId: id,
        q: z.string().max(100).optional(),
        arrival: date.optional(),
        date: date.optional(),
        status: z.string().max(40).optional(),
        view: z
          .enum(["arrivals", "departures", "vip", "inhouse", "changes"])
          .optional(),
      })
      .parse(req.query);
    const p = property(u, q.propertyId);
    const conditions = sql`tenant_id=${u.tenantId} AND property_id=${p} ${q.q ? sql`AND (confirmation ILIKE ${"%" + q.q + "%"} OR guest_name ILIKE ${"%" + q.q + "%"})` : sql``} ${q.arrival ? sql`AND arrival=${q.arrival}::date` : sql``} ${q.status ? sql`AND status=${q.status}` : sql``}`;
    const prop = (
      await db.query(sql`SELECT timezone FROM properties WHERE id=${p}`)
    )[0];
    const day =
      q.date ||
      new Intl.DateTimeFormat("en-CA", { timeZone: prop.timezone }).format(
        new Date(),
      );
    const view =
      q.view === "arrivals"
        ? sql`AND arrival=${day}::date AND status NOT IN ('Cancelled','NoShow')`
        : q.view === "departures"
          ? sql`AND departure=${day}::date AND status NOT IN ('Cancelled','NoShow')`
          : q.view === "vip"
            ? sql`AND arrival=${day}::date AND vip`
            : q.view === "inhouse"
              ? sql`AND status IN ('InHouse','DueOut')`
              : q.view === "changes"
                ? sql`AND updated_at::date=${day}::date`
                : sql``;
    const items = await db.query(
      sql`SELECT id,confirmation,guest_name,arrival::text,departure::text,status,room,vip,updated_at,source FROM reservations WHERE ${conditions} ${view} ORDER BY arrival,id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    );
    return {
      items,
      total: (
        await db.query(
          sql`SELECT count(*)::int AS total FROM reservations WHERE ${conditions} ${view}`,
        )
      )[0].total,
      page: q.page,
      limit: q.limit,
    };
  });
  app.get("/api/reservations/:id", async (req) => {
    const u = req.principal;
    requireRole(canGuests(u.role));
    const p = property(u, (req.query as any).propertyId);
    const r = (
      await db.query(
        sql`SELECT * FROM reservations WHERE tenant_id=${u.tenantId} AND property_id=${p} AND id=${id.parse((req.params as any).id)}`,
      )
    )[0];
    if (!r) throw fail(404, "Reservation not found");
    return {
      ...r,
      flags: await db.query(
        sql`SELECT flag FROM guest_flags WHERE tenant_id=${u.tenantId} AND property_id=${p} AND reservation_id=${r.id}`,
      ),
    };
  });
  app.get("/api/tasks", async (req) => {
    const u = req.principal,
      q = pagination.extend({ propertyId: id }).parse(req.query),
      p = property(u, q.propertyId);
    return {
      items: await db.query(
        sql`SELECT * FROM tasks WHERE tenant_id=${u.tenantId} AND property_id=${p} ORDER BY CASE priority WHEN 'high' THEN 0 ELSE 1 END,updated_at DESC,id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      ),
      total: (
        await db.query(
          sql`SELECT count(*)::int AS total FROM tasks WHERE tenant_id=${u.tenantId} AND property_id=${p}`,
        )
      )[0].total,
    };
  });
  app.get("/api/assignees", async (req) => {
    const u = req.principal,
      p = property(u, (req.query as any).propertyId);
    return {
      items: await db.query(
        sql`SELECT u.id,u.name FROM users u JOIN property_grants g ON g.user_id=u.id WHERE g.tenant_id=${u.tenantId} AND g.property_id=${p}`,
      ),
    };
  });
  app.post("/api/tasks", async (req) => {
    const u = req.principal;
    requireRole(u.role !== "it");
    const b = z
        .object({
          propertyId: id,
          title: z.string().trim().min(1).max(180),
          priority: z.enum(["high", "normal", "low"]),
        })
        .parse(req.body),
      p = property(u, b.propertyId),
      tid = randomUUID();
    await localDemoOnly(u, p);
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO tasks(id,tenant_id,property_id,title,priority) VALUES (${tid},${u.tenantId},${p},${b.title},${b.priority})`,
      );
      await audit(tx, u, p, "task.create", tid);
      await appendEvent(tx, u.tenantId, p, "tasks");
    });
    return { id: tid };
  });
  app.patch("/api/tasks/:id", async (req) => {
    const u = req.principal;
    requireRole(u.role !== "it");
    const b = z
        .object({
          propertyId: id,
          status: z.enum(["open", "acknowledged", "done"]),
          assignee: id.nullable(),
        })
        .parse(req.body),
      p = property(u, b.propertyId),
      tid = id.parse((req.params as any).id);
    if (
      b.assignee &&
      !(
        await db.query(
          sql`SELECT 1 FROM property_grants WHERE tenant_id=${u.tenantId} AND property_id=${p} AND user_id=${b.assignee}`,
        )
      ).length
    )
      throw fail(400, "Assignee has no property access");
    await localDemoOnly(u, p);
    await db.orm.transaction(async (tx) => {
      const r = await tx.execute(
        sql`UPDATE tasks SET status=${b.status},assignee=${b.assignee},updated_at=now() WHERE id=${tid} AND tenant_id=${u.tenantId} AND property_id=${p} RETURNING id`,
      );
      if (!r.rows.length) throw fail(404, "Task not found");
      await audit(tx, u, p, "task.update", tid);
      await appendEvent(tx, u.tenantId, p, "tasks");
    });
    return { ok: true };
  });
  app.get("/api/rooms", async (req) => {
    const u = req.principal,
      q = pagination.extend({ propertyId: id }).parse(req.query),
      p = property(u, q.propertyId);
    return {
      items: await db.query(
        sql`SELECT * FROM rooms WHERE tenant_id=${u.tenantId} AND property_id=${p} ORDER BY id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      ),
      total: (
        await db.query(
          sql`SELECT count(*)::int AS total FROM rooms WHERE tenant_id=${u.tenantId} AND property_id=${p}`,
        )
      )[0].total,
    };
  });
  app.patch("/api/rooms/:id", async (req) => {
    const u = req.principal;
    requireRole(
      [
        "platform_admin",
        "group_admin",
        "hotel_manager",
        "housekeeping",
      ].includes(u.role),
    );
    const b = z
        .object({
          propertyId: id,
          status: z.enum(["clean", "dirty", "inspected", "out_of_order"]),
          attention: z.string().max(180),
        })
        .parse(req.body),
      p = property(u, b.propertyId),
      rid = id.parse((req.params as any).id);
    await localDemoOnly(u, p);
    await db.orm.transaction(async (tx) => {
      const result = await tx.execute(
        sql`UPDATE rooms SET status=${b.status},attention=${b.attention},updated_at=now() WHERE tenant_id=${u.tenantId} AND property_id=${p} AND id=${rid} RETURNING id`,
      );
      if (!result.rows.length) throw fail(404, "Room not found");
      await audit(tx, u, p, "room.update", rid);
      await appendEvent(tx, u.tenantId, p, "rooms");
    });
    return { ok: true };
  });
  for (const resource of [
    "connections",
    "integration_logs",
    "retry_jobs",
    "audit_logs",
  ] as const)
    app.get("/api/" + resource.replaceAll("_", "-"), async (req) => {
      const u = req.principal;
      requireRole(
        resource === "audit_logs" ? canAdmin(u.role) : canIntegrate(u.role),
      );
      const q = pagination
        .extend({ propertyId: id.optional() })
        .parse(req.query);
      if (q.propertyId) property(u, q.propertyId);
      const columns =
        resource === "connections"
          ? sql`id,property_id,mode,environment,status,last_sync,checkpoint`
          : sql`*`;
      const where = sql`tenant_id=${u.tenantId} AND (property_id IN (${scope(u)}) ${resource === "audit_logs" ? sql`OR property_id IS NULL` : sql``}) ${q.propertyId ? sql`AND property_id=${q.propertyId}` : sql``}`;
      return {
        items: await db.query(
          sql`SELECT ${columns} FROM ${sql.identifier(resource)} WHERE ${where} ORDER BY ${resource === "connections" ? sql`id` : resource === "retry_jobs" ? sql`next_at DESC,id` : sql`created_at DESC,id`} LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
        ),
        total: (
          await db.query(
            sql`SELECT count(*)::int AS total FROM ${sql.identifier(resource)} WHERE ${where}`,
          )
        )[0].total,
      };
    });
  registerConnectionCenter(app, db, options.ohipTransport);
  // Retain the demo source switch for existing callers; live credentials use the OCIM center.
  app.put("/api/connections", async (req) => {
    const u = req.principal;
    requireRole(canIntegrate(u.role));
    const b = z
      .strictObject({
        propertyId: id,
        mode: z.literal("demo"),
        environment: z.literal("DEMO"),
      })
      .parse(req.body);
    const p = property(u, b.propertyId);
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${u.tenantId},7291043001))`,
      );
      if (
        (
          await tx.execute(
            sql`SELECT 1 FROM reservations WHERE tenant_id=${u.tenantId} AND property_id=${p} AND source!='DEMO' LIMIT 1`,
          )
        ).rows.length
      )
        throw fail(409, "Use an empty property when changing sources");
      if (
        (
          await tx.execute(
            sql`SELECT 1 FROM ohip_connection_properties WHERE tenant_id=${u.tenantId} AND property_id=${p}`,
          )
        ).rows.length
      )
        throw fail(
          409,
          "An Oracle connection is assigned; use a separate property for demo data",
        );
      await tx.execute(
        sql`INSERT INTO connections(id,tenant_id,property_id,mode,environment,status) VALUES (${randomUUID()},${u.tenantId},${p},'demo','DEMO','demo') ON CONFLICT(property_id) DO UPDATE SET mode='demo',environment='DEMO',status='demo',next_poll=now()`,
      );
      await audit(tx, u, p, "connection.configure", p);
      await appendEvent(tx, u.tenantId, p, "integrations");
    });
    return { ok: true };
  });
  app.post("/api/retry-jobs/:id/retry", async (req) => {
    const u = req.principal;
    requireRole(canIntegrate(u.role));
    const p = property(u, (req.body as any)?.propertyId),
      jid = id.parse((req.params as any).id);
    await db.orm.transaction(async (tx) => {
      const result = await tx.execute(
        sql`UPDATE retry_jobs SET state='queued',attempts=0,next_at=now(),lease_until=NULL WHERE id=${jid} AND tenant_id=${u.tenantId} AND property_id=${p} AND operation='reservation_poll' AND state IN ('dead','queued') RETURNING id`,
      );
      if (!result.rows.length) throw fail(409, "Job cannot be retried");
      await audit(tx, u, p, "retry.manual", jid);
      await appendEvent(tx, u.tenantId, p, "integrations");
    });
    return { ok: true };
  });
  app.get("/api/admin", async (req) => {
    const u = req.principal;
    requireRole(canAdmin(u.role));
    return {
      tenants: await db.query(
        sql`SELECT * FROM tenants WHERE id=${u.tenantId}`,
      ),
      organizations: await db.query(
        sql`SELECT * FROM organizations WHERE tenant_id=${u.tenantId}`,
      ),
      properties: await db.query(
        sql`SELECT * FROM properties WHERE tenant_id=${u.tenantId} AND id IN (${scope(u)})`,
      ),
      users: await db.query(
        sql`SELECT u.id,u.name,u.email,m.role,(SELECT coalesce(json_agg(property_id),'[]') FROM property_grants g WHERE g.user_id=u.id AND g.tenant_id=m.tenant_id) AS properties FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.tenant_id=${u.tenantId}`,
      ),
    };
  });
  app.post("/api/admin/tenants", async (req) => {
    const u = req.principal;
    requireRole(u.role === "platform_admin");
    const b = z
        .object({
          name: z.string().trim().min(1).max(100),
          hostname: z
            .string()
            .min(1)
            .max(253)
            .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
        })
        .parse(req.body),
      tid = randomUUID();
    await db.orm.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO tenants VALUES (${tid},${b.name})`);
      await tx.execute(
        sql`INSERT INTO memberships VALUES (${tid},${u.id},'platform_admin')`,
      );
      await tx.execute(
        sql`INSERT INTO branding_profiles VALUES (${tid},'Hospitality Operations','#17675d','','/favicon.svg')`,
      );
      await tx.execute(
        sql`INSERT INTO app_instances VALUES (${randomUUID()},${tid},${b.hostname})`,
      );
      await audit(tx, u, null, "tenant.create", tid);
      await audit(tx, { ...u, tenantId: tid }, null, "tenant.provision", tid);
    });
    return { id: tid };
  });
  app.put("/api/branding", async (req) => {
    const u = req.principal;
    requireRole(canAdmin(u.role));
    const asset = z
      .string()
      .max(300)
      .refine(
        (s) =>
          s === "" ||
          (s.startsWith("/") && !s.startsWith("//")) ||
          /^https:\/\//.test(s),
        "Use a local path or HTTPS asset",
      );
    const b = z
      .object({
        appName: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .refine(
            (v) => !/heisenberg/i.test(v),
            "Internal names are not allowed",
          ),
        primary: z.string().regex(/^#[a-f0-9]{6}$/i),
        logo: asset,
        favicon: asset,
      })
      .parse(req.body);
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO branding_profiles VALUES (${u.tenantId},${b.appName},${b.primary},${b.logo},${b.favicon}) ON CONFLICT(tenant_id) DO UPDATE SET app_name=excluded.app_name,primary_color=excluded.primary_color,logo=excluded.logo,favicon=excluded.favicon`,
      );
      await audit(tx, u, null, "branding.update", u.tenantId);
      await appendEvent(tx, u.tenantId, null, "branding");
    });
    return { ok: true };
  });
  app.post("/api/admin/organizations", async (req) => {
    const u = req.principal;
    requireRole(canAdmin(u.role));
    const b = z
        .object({ name: z.string().trim().min(1).max(100) })
        .parse(req.body),
      oid = randomUUID();
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO organizations VALUES (${oid},${u.tenantId},${b.name})`,
      );
      await audit(tx, u, null, "organization.create", oid);
    });
    return { id: oid };
  });
  app.post("/api/admin/properties", async (req) => {
    const u = req.principal;
    requireRole(canAdmin(u.role));
    const b = z
      .object({
        name: z.string().trim().min(1).max(100),
        organizationId: id,
        timezone: z.string().refine((v) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: v });
            return true;
          } catch {
            return false;
          }
        }),
      })
      .parse(req.body);
    if (
      !(
        await db.query(
          sql`SELECT 1 FROM organizations WHERE id=${b.organizationId} AND tenant_id=${u.tenantId}`,
        )
      ).length
    )
      throw fail(403, "Organization denied");
    const pid = randomUUID();
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO properties VALUES (${pid},${u.tenantId},${b.organizationId},${b.name},${b.timezone})`,
      );
      await tx.execute(
        sql`INSERT INTO property_grants VALUES (${u.tenantId},${u.id},${pid})`,
      );
      await audit(tx, u, pid, "property.create", pid);
      await appendEvent(tx, u.tenantId, null, "reconcile");
    });
    return { id: pid };
  });
  app.post("/api/admin/users", async (req) => {
    const u = req.principal;
    requireRole(canAdmin(u.role));
    const b = z
      .object({
        name: z.string().min(1).max(100),
        email: z.email(),
        password: z.string().min(12).max(256),
        role: z.enum(roles),
        properties: z.array(id).max(100),
      })
      .parse(req.body);
    if (b.role === "platform_admin" && u.role !== "platform_admin")
      throw fail(403, "Cannot grant platform role");
    b.properties.forEach((p) => property(u, p));
    const uid = randomUUID(),
      hash = await hashPassword(b.password);
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO users(id,email,name,password_hash) VALUES (${uid},${b.email.toLowerCase()},${b.name},${hash})`,
      );
      await tx.execute(
        sql`INSERT INTO memberships VALUES (${u.tenantId},${uid},${b.role})`,
      );
      for (const p of new Set(b.properties))
        await tx.execute(
          sql`INSERT INTO property_grants VALUES (${u.tenantId},${uid},${p})`,
        );
      await audit(tx, u, null, "user.create", uid);
    });
    return { id: uid };
  });
  app.patch("/api/admin/users/:id", async (req) => {
    const u = req.principal;
    requireRole(canAdmin(u.role));
    const uid = id.parse((req.params as any).id),
      b = z
        .object({ role: z.enum(roles), properties: z.array(id).max(100) })
        .parse(req.body);
    if (uid === u.id)
      throw fail(409, "Use another administrator to change your own access");
    const target = (
      await db.query(
        sql`SELECT role FROM memberships WHERE tenant_id=${u.tenantId} AND user_id=${uid}`,
      )
    )[0];
    if (!target) throw fail(404, "Membership not found");
    if (
      (target.role === "platform_admin" || b.role === "platform_admin") &&
      u.role !== "platform_admin"
    )
      throw fail(403, "Cannot manage platform role");
    const targetGrants = await db.query(
      sql`SELECT property_id FROM property_grants WHERE tenant_id=${u.tenantId} AND user_id=${uid}`,
    );
    targetGrants.forEach((g) => property(u, g.property_id));
    b.properties.forEach((p) => property(u, p));
    await db.orm.transaction(async (tx) => {
      const grants = b.properties.length
        ? sql.join(
            b.properties.map((p) => sql`${p}`),
            sql`, `,
          )
        : sql`NULL`;
      await tx.execute(
        sql`UPDATE tasks SET assignee=NULL,updated_at=now() WHERE tenant_id=${u.tenantId} AND assignee=${uid} AND property_id NOT IN (${grants})`,
      );
      await tx.execute(
        sql`DELETE FROM property_grants WHERE tenant_id=${u.tenantId} AND user_id=${uid} AND property_id NOT IN (${grants})`,
      );
      for (const p of new Set(b.properties))
        await tx.execute(
          sql`INSERT INTO property_grants VALUES (${u.tenantId},${uid},${p}) ON CONFLICT DO NOTHING`,
        );
      await tx.execute(
        sql`UPDATE memberships SET role=${b.role} WHERE tenant_id=${u.tenantId} AND user_id=${uid}`,
      );
      await tx.execute(
        sql`DELETE FROM sessions WHERE tenant_id=${u.tenantId} AND user_id=${uid}`,
      );
      await audit(tx, u, null, "membership.update", uid);
      await appendEvent(tx, u.tenantId, null, "reconcile");
    });
    return { ok: true };
  });
  app.get("/api/developer", async (req) => {
    requireRole(req.principal.developer);
    return {
      coreVersion: "1.0.0",
      ohipAccessMode: "read_only",
      ohipMutationsEnabled: false,
      approvedOhipOperations: Object.keys(APPROVED_OHIP_OPERATIONS).join(", "),
      contract: "Oracle RSV 26.2 / 26.3",
      compatibility:
        "Fixtures validated against release tags 26.2, 26.3, v26.4 (RSV schema remains 26.3); live environments unverified",
      ingestion: "Controlled polling; streaming not enabled",
      productionValidated: false,
    };
  });
  app.addHook("onClose", async () => rt.close());
  return app;
}
