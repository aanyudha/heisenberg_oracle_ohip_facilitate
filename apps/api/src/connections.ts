import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql, type Database } from "./db.js";
import { canAdmin, canIntegrate } from "@hospitality/contracts";
import { type Principal, appendEvent } from "./realtime.js";
import { encrypt } from "./security.js";
import { RealOhipAdapter, OhipError, validateGateway } from "./ohip.js";
import {
  credentials,
  findOrCreateConnection,
  sameCredentials,
  type Credentials,
  type ConnectionTransaction,
} from "./connection-store.js";
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) =>
      [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
    );
const secret = z
  .string()
  .min(1)
  .max(1000)
  .refine((v) =>
    [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  );
const hotel = text(40).regex(/^[A-Za-z0-9_.-]+$/);
const connectionFields = {
  baseUrl: text(300),
  clientId: text(200).refine((v) => !v.includes(":")),
  clientSecret: secret,
  appKey: secret,
  enterpriseId: text(100),
  hotelId: hotel,
};
const createSchema = z.strictObject({
  propertyId: text(100),
  ...connectionFields,
});
const editSchema = createSchema.extend({
  clientSecret: secret.or(z.literal("")).optional(),
  appKey: secret.or(z.literal("")).optional(),
});
function fail(statusCode: number, message: string) {
  return Object.assign(Error(message), { statusCode });
}
function permitted(u: Principal) {
  if (!canIntegrate(u.role)) throw fail(403, "Permission denied");
}
function property(u: Principal, p: string) {
  if (!u.properties.includes(p)) throw fail(403, "Property access denied");
  return p;
}
const scope = (u: Principal) =>
  u.properties.length
    ? sql.join(
        u.properties.map((p) => sql`${p}`),
        sql`,`,
      )
    : sql`NULL`;
export function registerConnectionCenter(
  app: FastifyInstance,
  db: Database,
  transport: typeof fetch = fetch,
) {
  async function source(u: Principal, p: string) {
    if (
      (
        await db.query(
          sql`SELECT 1 FROM reservations WHERE tenant_id=${u.tenantId} AND property_id=${p} AND source='DEMO' LIMIT 1`,
        )
      ).length
    )
      throw fail(
        409,
        "Property contains demo reservations. Choose an empty property before activating Oracle.",
      );
  }
  async function get(u: Principal, connectionId: string, all = false) {
    const row = (
      await db.query(
        sql`SELECT *,updated_at::text AS revision FROM ohip_connections WHERE tenant_id=${u.tenantId} AND id=${connectionId}`,
      )
    )[0];
    if (!row) throw fail(404, "Connection not found");
    const assignments = await db.query(
      sql`SELECT * FROM ohip_connection_properties WHERE tenant_id=${u.tenantId} AND connection_id=${connectionId} ORDER BY property_id`,
    );
    if (
      (!assignments.length && !canAdmin(u.role)) ||
      (assignments.length &&
        !(all
          ? assignments.every((m) => u.properties.includes(m.property_id))
          : assignments.some((m) => u.properties.includes(m.property_id))))
    )
      throw fail(
        403,
        all
          ? "Editing shared credentials requires access to every assigned property. Create a dedicated connection for this property instead."
          : "Connection access denied",
      );
    return { row, assignments };
  }
  function candidate(
    u: Principal,
    value: Credentials,
    hotelId: string,
    connectionId?: string,
  ) {
    if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY || ""))
      throw fail(
        400,
        "Configure a valid ENCRYPTION_KEY on the server before saving OHIP credentials.",
      );
    return {
      tenant_id: u.tenantId,
      connection_id: connectionId,
      base_url: validateGateway(value.baseUrl),
      client_id: value.clientId,
      encrypted_client_secret: encrypt(value.clientSecret),
      encrypted_app_key: encrypt(value.appKey),
      enterprise_id: value.enterpriseId,
      hotel_id: hotelId,
    };
  }
  async function validate(
    u: Principal,
    p: string,
    row: Record<string, any>,
    hotelId: string,
  ) {
    return new RealOhipAdapter(
      {
        ...row,
        tenant_id: u.tenantId,
        connection_id: row.id || row.connection_id,
        hotel_id: hotelId,
      },
      transport,
      async (e) => {
        await db.query(
          sql`INSERT INTO integration_logs(id,tenant_id,property_id,operation,status,latency,classification,correlation_id) VALUES (${randomUUID()},${u.tenantId},${p},${e.operation},${e.status},${e.latency},${e.classification},${e.correlationId})`,
        );
      },
    ).testConnection();
  }
  async function lock(tx: ConnectionTransaction, tenantId: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenantId},7291043001))`,
    );
  }
  async function audit(
    tx: ConnectionTransaction,
    u: Principal,
    p: string,
    action: string,
    target: string,
  ) {
    await tx.execute(
      sql`INSERT INTO audit_logs(id,tenant_id,property_id,actor,action,target) VALUES (${randomUUID()},${u.tenantId},${p},${u.id},${action},${target})`,
    );
    await appendEvent(tx, u.tenantId, p, "integrations");
  }
  async function assign(
    tx: ConnectionTransaction,
    u: Principal,
    p: string,
    connectionId: string,
    hotelId: string,
  ) {
    await tx.execute(
      sql`INSERT INTO ohip_connection_properties(id,tenant_id,connection_id,property_id,hotel_id,is_primary,validation_status,last_validated_at) VALUES (${randomUUID()},${u.tenantId},${connectionId},${p},${hotelId},NOT EXISTS(SELECT 1 FROM ohip_connection_properties WHERE tenant_id=${u.tenantId} AND connection_id=${connectionId} AND property_id!=${p} AND is_primary),'validated',now()) ON CONFLICT(tenant_id,property_id) DO UPDATE SET connection_id=excluded.connection_id,hotel_id=excluded.hotel_id,is_primary=excluded.is_primary,validation_status='validated',last_validated_at=now()`,
    );
    await tx.execute(
      sql`UPDATE ohip_connection_properties SET is_primary=true WHERE id IN (SELECT DISTINCT ON (connection_id) id FROM ohip_connection_properties m WHERE tenant_id=${u.tenantId} AND NOT EXISTS(SELECT 1 FROM ohip_connection_properties p WHERE p.tenant_id=m.tenant_id AND p.connection_id=m.connection_id AND p.is_primary) ORDER BY connection_id,id)`,
    );
    await tx.execute(
      sql`INSERT INTO connections(id,tenant_id,property_id,mode,environment,status) VALUES (${randomUUID()},${u.tenantId},${p},'real','OCIM','connected') ON CONFLICT(property_id) DO UPDATE SET mode='real',environment='OCIM',encrypted_secret=NULL,status='connected',last_sync=NULL,checkpoint='{}',next_poll=now()`,
    );
    await tx.execute(
      sql`UPDATE ohip_connections SET status='connected' WHERE tenant_id=${u.tenantId} AND id=${connectionId}`,
    );
    await audit(tx, u, p, "connection.assign", connectionId);
  }
  app.get("/api/ohip-connections", async (req) => {
    const u = req.principal;
    permitted(u);
    const q = z
      .object({
        propertyId: text(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(100),
      })
      .parse(req.query);
    if (q.propertyId) property(u, q.propertyId);
    const where = sql`c.tenant_id=${u.tenantId} AND (EXISTS(SELECT 1 FROM ohip_connection_properties m WHERE m.tenant_id=c.tenant_id AND m.connection_id=c.id AND m.property_id IN (${scope(u)})) OR (${canAdmin(u.role)} AND NOT EXISTS(SELECT 1 FROM ohip_connection_properties m WHERE m.tenant_id=c.tenant_id AND m.connection_id=c.id)))`;
    const items = await db.query(
      sql`SELECT c.id,c.base_url,c.client_id,c.enterprise_id,c.status,c.created_at,c.updated_at,NOT EXISTS(SELECT 1 FROM ohip_connection_properties m WHERE m.tenant_id=c.tenant_id AND m.connection_id=c.id AND m.property_id NOT IN (${scope(u)})) AS can_edit FROM ohip_connections c WHERE ${where} ORDER BY c.created_at,c.id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    );
    for (const c of items) {
      c.assigned_properties = await db.query(
        sql`SELECT m.id,m.property_id,p.name,m.hotel_id,m.is_primary,m.validation_status,m.last_validated_at,s.status,s.last_sync FROM ohip_connection_properties m JOIN properties p ON p.tenant_id=m.tenant_id AND p.id=m.property_id LEFT JOIN connections s ON s.tenant_id=m.tenant_id AND s.property_id=m.property_id WHERE m.tenant_id=${u.tenantId} AND m.connection_id=${c.id} AND m.property_id IN (${scope(u)}) ORDER BY p.name`,
      );
      c.health = c.assigned_properties.some(
        (m: any) =>
          m.status === "degraded" || m.validation_status === "invalid",
      )
        ? "degraded"
        : c.assigned_properties.some(
              (m: any) => m.validation_status === "pending",
            )
          ? "pending"
          : c.status;
      c.last_connected = c.assigned_properties.reduce(
        (last: string | null, m: any) => {
          const date =
            m.last_sync ||
            (m.validation_status === "validated" ? m.last_validated_at : null);
          return date && (!last || new Date(date) > new Date(last))
            ? date
            : last;
        },
        null,
      );
    }
    return {
      items,
      total: (
        await db.query(
          sql`SELECT count(*)::int AS total FROM ohip_connections c WHERE ${where}`,
        )
      )[0].total,
    };
  });
  app.post("/api/ohip-connections", async (req) => {
    const u = req.principal;
    permitted(u);
    const b = createSchema.parse(req.body),
      p = property(u, b.propertyId);
    await source(u, p);
    const value: Credentials = {
      baseUrl: validateGateway(b.baseUrl),
      clientId: b.clientId,
      clientSecret: b.clientSecret,
      appKey: b.appKey,
      enterpriseId: b.enterpriseId,
    };
    const row = candidate(u, value, b.hotelId);
    await validate(u, p, row, b.hotelId);
    const id = await db.orm.transaction(async (tx) => {
      await lock(tx, u.tenantId);
      await assertSource(tx, u, p);
      const id = await findOrCreateConnection(tx, u.tenantId, value);
      await assign(tx, u, p, id, b.hotelId);
      return id;
    });
    return { ok: true, id };
  });
  async function assertSource(
    tx: ConnectionTransaction,
    u: Principal,
    p: string,
  ) {
    if (
      (
        await tx.execute(
          sql`SELECT 1 FROM reservations WHERE tenant_id=${u.tenantId} AND property_id=${p} AND source='DEMO' LIMIT 1`,
        )
      ).rows.length
    )
      throw fail(
        409,
        "Property contains demo reservations; Oracle activation was cancelled.",
      );
  }
  app.post("/api/ohip-connections/:id/assign", async (req) => {
    const u = req.principal;
    permitted(u);
    const b = z
        .strictObject({ propertyId: text(100), hotelId: hotel })
        .parse(req.body),
      p = property(u, b.propertyId),
      cid = text(100).parse((req.params as any).id);
    const { row } = await get(u, cid);
    await source(u, p);
    await validate(u, p, row, b.hotelId);
    await db.orm.transaction(async (tx) => {
      await lock(tx, u.tenantId);
      await assertUnchanged(tx, u, row);
      await assertSource(tx, u, p);
      await assign(tx, u, p, cid, b.hotelId);
    });
    return { ok: true };
  });
  async function assertUnchanged(
    tx: ConnectionTransaction,
    u: Principal,
    row: Record<string, any>,
  ) {
    if (
      !(
        await tx.execute(
          sql`SELECT 1 FROM ohip_connections WHERE tenant_id=${u.tenantId} AND id=${row.id} AND updated_at::text=${row.revision}`,
        )
      ).rows.length
    )
      throw fail(
        409,
        "Connection changed during validation. Reload and retry.",
      );
  }
  app.post("/api/ohip-connections/:id/test", async (req) => {
    const u = req.principal;
    permitted(u);
    const b = z.strictObject({ propertyId: text(100) }).parse(req.body),
      p = property(u, b.propertyId),
      cid = text(100).parse((req.params as any).id);
    const { row, assignments } = await get(u, cid);
    const mapped = assignments.find((m) => m.property_id === p);
    if (!mapped) throw fail(404, "Connection is not assigned to this property");
    let failure: unknown;
    try {
      await validate(u, p, row, mapped.hotel_id);
    } catch (error) {
      failure = error;
    }
    await db.orm.transaction(async (tx) => {
      await lock(tx, u.tenantId);
      await assertUnchanged(tx, u, row);
      const updated = await tx.execute(
        sql`UPDATE ohip_connection_properties SET validation_status=${failure ? "invalid" : "validated"},last_validated_at=now() WHERE tenant_id=${u.tenantId} AND connection_id=${cid} AND property_id=${p} AND hotel_id=${mapped.hotel_id} RETURNING id`,
      );
      if (!updated.rows.length)
        throw fail(
          409,
          "Property assignment changed during validation. Reload and retry.",
        );
      await tx.execute(
        sql`UPDATE connections SET status=${failure ? "degraded" : "connected"},next_poll=now() WHERE tenant_id=${u.tenantId} AND property_id=${p}`,
      );
      if (!failure)
        await tx.execute(
          sql`UPDATE ohip_connections SET status='connected' WHERE tenant_id=${u.tenantId} AND id=${cid}`,
        );
      await audit(
        tx,
        u,
        p,
        failure ? "connection.test_failed" : "connection.test",
        cid,
      );
    });
    if (failure)
      throw failure instanceof OhipError
        ? failure
        : new OhipError(502, "connection_test_failed");
    return { ok: true, status: "connected" };
  });
  app.patch("/api/ohip-connections/:id", async (req) => {
    const u = req.principal;
    permitted(u);
    const b = editSchema.parse(req.body),
      p = property(u, b.propertyId),
      cid = text(100).parse((req.params as any).id);
    const { row, assignments } = await get(u, cid, true);
    if (!assignments.some((m) => m.property_id === p))
      throw fail(404, "Connection is not assigned to this property");
    const stored = credentials(row),
      value: Credentials = {
        baseUrl: validateGateway(b.baseUrl),
        clientId: b.clientId,
        clientSecret: b.clientSecret || stored.clientSecret,
        appKey: b.appKey || stored.appKey,
        enterpriseId: b.enterpriseId,
      };
    const changed = !sameCredentials(stored, value),
      next = candidate(u, value, b.hotelId, cid);
    const targets = changed
      ? assignments
      : assignments.filter((m) => m.property_id === p);
    for (const m of targets)
      await validate(
        u,
        m.property_id,
        next,
        m.property_id === p ? b.hotelId : m.hotel_id,
      );
    await db.orm.transaction(async (tx) => {
      await lock(tx, u.tenantId);
      await assertUnchanged(tx, u, row);
      const current = (
        await tx.execute(
          sql`SELECT property_id,hotel_id FROM ohip_connection_properties WHERE tenant_id=${u.tenantId} AND connection_id=${cid} ORDER BY property_id`,
        )
      ).rows;
      if (
        JSON.stringify(current) !==
        JSON.stringify(
          assignments.map((m) => ({
            property_id: m.property_id,
            hotel_id: m.hotel_id,
          })),
        )
      )
        throw fail(
          409,
          "Assignments changed during validation. Reload and retry.",
        );
      if (changed) {
        const duplicate = (
          await tx.execute(
            sql`SELECT * FROM ohip_connections WHERE tenant_id=${u.tenantId} AND id!=${cid} AND base_url=${value.baseUrl} AND client_id=${value.clientId} AND enterprise_id=${value.enterpriseId}`,
          )
        ).rows.find((c) => sameCredentials(credentials(c), value));
        if (duplicate)
          throw fail(
            409,
            "These credentials already exist. Use Existing Connection instead.",
          );
        await tx.execute(
          sql`UPDATE ohip_connections SET base_url=${value.baseUrl},client_id=${value.clientId},encrypted_client_secret=${next.encrypted_client_secret},encrypted_app_key=${next.encrypted_app_key},enterprise_id=${value.enterpriseId},status='connected',updated_at=now() WHERE tenant_id=${u.tenantId} AND id=${cid}`,
        );
      }
      await tx.execute(
        sql`UPDATE ohip_connection_properties SET hotel_id=${b.hotelId} WHERE tenant_id=${u.tenantId} AND connection_id=${cid} AND property_id=${p}`,
      );
      for (const m of targets) {
        await tx.execute(
          sql`UPDATE ohip_connection_properties SET validation_status='validated',last_validated_at=now() WHERE tenant_id=${u.tenantId} AND connection_id=${cid} AND property_id=${m.property_id}`,
        );
        await tx.execute(
          sql`UPDATE connections SET status='connected',next_poll=now() WHERE tenant_id=${u.tenantId} AND property_id=${m.property_id}`,
        );
        await audit(tx, u, m.property_id, "connection.update", cid);
      }
    });
    return { ok: true };
  });
}
