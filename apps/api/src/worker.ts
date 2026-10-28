import { randomUUID, createHash } from "node:crypto";
import { sql, type Database } from "./db.js";
import {
  MockAdapter,
  RealOhipAdapter,
  OhipError,
  classify,
  type OperationsAdapter,
} from "./ohip.js";
import { appendEvent } from "./realtime.js";
export const backoff = (attempt: number, random = Math.random()) =>
  Math.min(300000, 1000 * 2 ** Math.min(attempt, 10)) +
  Math.floor(random * 1000);
export const retrySafe = (operation: string) =>
  operation === "reservation_poll";
export function worker(
  db: Database,
  adapterFactory?: (c: Record<string, any>) => OperationsAdapter,
) {
  const adapters = new Map<
    string,
    { secret: string; adapter: OperationsAdapter }
  >();
  let busy = false;
  function adapter(c: Record<string, any>) {
    if (adapterFactory) return adapterFactory(c);
    const existing = adapters.get(c.id);
    const revision = JSON.stringify([
      c.connection_id,
      c.base_url,
      c.client_id,
      c.encrypted_client_secret,
      c.encrypted_app_key,
      c.enterprise_id,
      c.hotel_id,
      c.mode,
    ]);
    if (existing && existing.secret === revision) return existing.adapter;
    const a =
      c.mode === "demo"
        ? new MockAdapter()
        : new RealOhipAdapter(c, fetch, async (e) => {
            await db.query(
              sql`INSERT INTO integration_logs(id,tenant_id,property_id,operation,status,latency,classification,correlation_id) VALUES (${randomUUID()},${c.tenant_id},${c.property_id},${e.operation},${e.status},${e.latency},${e.classification},${e.correlationId})`,
            );
          });
    adapters.set(c.id, { secret: revision, adapter: a });
    return a;
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await db.query(
        sql`UPDATE retry_jobs SET state='queued',lease_until=NULL WHERE state='running' AND lease_until<now()`,
      );
      const connections = await db.query(
        sql`UPDATE connections SET lease_until=now()+interval '15 minutes',next_poll=now()+${Math.max(30000, Number(process.env.POLL_INTERVAL_MS) || 60000)}*interval '1 millisecond' WHERE id IN (SELECT id FROM connections s WHERE next_poll<=now() AND (lease_until IS NULL OR lease_until<now()) AND (mode='demo' OR EXISTS(SELECT 1 FROM ohip_connection_properties m WHERE m.tenant_id=s.tenant_id AND m.property_id=s.property_id AND m.validation_status='validated')) ORDER BY next_poll LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *`,
      );
      for (const c of connections) {
        await db.query(
          sql`INSERT INTO retry_jobs(id,tenant_id,property_id,operation,idempotency_key,state) VALUES (${randomUUID()},${c.tenant_id},${c.property_id},'reservation_poll',${randomUUID()},'queued') ON CONFLICT DO NOTHING`,
        );
        await db.query(
          sql`UPDATE connections SET lease_until=NULL WHERE id=${c.id}`,
        );
      }
      for (let batch = 0; batch < 5; batch++) {
        // Start each lease immediately before its operation, so queued jobs do
        // not consume their lease while earlier network requests are running.
        const job = (
          await db.query(
            sql`UPDATE retry_jobs SET state='running',lease_until=now()+interval '15 minutes' WHERE id IN (SELECT id FROM retry_jobs WHERE state='queued' AND next_at<=now() ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`,
          )
        )[0];
        if (!job) break;
        const c = (
          await db.query(
            sql`SELECT c.*,p.timezone,m.hotel_id AS mapped_hotel_id,m.validation_status,o.id AS connection_id,o.base_url,o.client_id,o.encrypted_client_secret,o.encrypted_app_key,o.enterprise_id AS mapped_enterprise_id,o.updated_at::text AS credential_revision FROM connections c JOIN properties p ON p.tenant_id=c.tenant_id AND p.id=c.property_id LEFT JOIN ohip_connection_properties m ON m.tenant_id=c.tenant_id AND m.property_id=c.property_id LEFT JOIN ohip_connections o ON o.tenant_id=m.tenant_id AND o.id=m.connection_id WHERE c.tenant_id=${job.tenant_id} AND c.property_id=${job.property_id}`,
          )
        )[0];
        const started = Date.now(),
          correlation = randomUUID();
        try {
          if (!c || !retrySafe(job.operation))
            throw new OhipError(400, "unsafe_operation");
          if (c.mode === "real") {
            if (!c.connection_id || c.validation_status !== "validated")
              throw new OhipError(403, "property_not_validated");
            c.hotel_id = c.mapped_hotel_id;
            c.enterprise_id = c.mapped_enterprise_id;
          }
          const date = new Intl.DateTimeFormat("en-CA", {
            timeZone: c.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date());
          const cachedIds = (
            await db.query(
              sql`SELECT id FROM reservations WHERE tenant_id=${job.tenant_id} AND property_id=${job.property_id} AND source!='DEMO' AND (arrival=${date}::date OR departure=${date}::date OR status IN ('InHouse','DueOut')) ORDER BY id LIMIT 1001`,
            )
          ).map((r) => String(r.id));
          const result = await adapter(c).read(date, cachedIds);
          await db.orm.transaction(async (tx) => {
            if (c.mode === "real") {
              await tx.execute(
                sql`SELECT pg_advisory_xact_lock(hashtextextended(${job.tenant_id},7291043001))`,
              );
              if (
                !(
                  await tx.execute(
                    sql`SELECT 1 FROM connections s JOIN ohip_connection_properties m ON m.tenant_id=s.tenant_id AND m.property_id=s.property_id JOIN ohip_connections o ON o.tenant_id=m.tenant_id AND o.id=m.connection_id WHERE s.tenant_id=${job.tenant_id} AND s.property_id=${job.property_id} AND s.mode='real' AND m.connection_id=${c.connection_id} AND m.hotel_id=${c.hotel_id} AND m.validation_status='validated' AND o.updated_at::text=${c.credential_revision}`,
                  )
                ).rows.length
              )
                throw new OhipError(409, "connection_changed");
            }
            for (const r of result.items) {
              const fingerprint = createHash("sha256")
                .update(JSON.stringify(r))
                .digest("hex");
              const inserted = await tx.execute(
                sql`INSERT INTO integration_events(tenant_id,property_id,source_id) VALUES (${job.tenant_id},${job.property_id},${r.id + ":" + fingerprint}) ON CONFLICT DO NOTHING RETURNING source_id`,
              );
              // Snapshot reconciliation must apply A→B→A transitions even when a fingerprint was seen before.
              void inserted;
              await tx.execute(
                sql`INSERT INTO reservations(id,tenant_id,property_id,confirmation,guest_name,arrival,departure,status,room,vip,source) VALUES (${r.id},${job.tenant_id},${job.property_id},${r.confirmation},${r.guest_name},${r.arrival},${r.departure},${r.status},${r.room},${r.vip},${r.source}) ON CONFLICT(tenant_id,property_id,id) DO UPDATE SET confirmation=excluded.confirmation,guest_name=excluded.guest_name,arrival=excluded.arrival,departure=excluded.departure,status=excluded.status,room=excluded.room,vip=excluded.vip,source=excluded.source,updated_at=now() WHERE (reservations.confirmation,reservations.guest_name,reservations.arrival,reservations.departure,reservations.status,reservations.room,reservations.vip,reservations.source) IS DISTINCT FROM (excluded.confirmation,excluded.guest_name,excluded.arrival,excluded.departure,excluded.status,excluded.room,excluded.vip,excluded.source)`,
              );
            }
            await tx.execute(
              sql`UPDATE connections SET status=${c.mode === "demo" ? "demo" : "connected"},last_sync=now(),checkpoint=${JSON.stringify({ date, completedAt: new Date().toISOString(), strategy: "bounded_daily_reconciliation" })}::jsonb WHERE id=${c.id}`,
            );
            if (c.mode === "real")
              await tx.execute(
                sql`UPDATE ohip_connections SET status='connected' WHERE tenant_id=${job.tenant_id} AND id=${c.connection_id}`,
              );
            await tx.execute(
              sql`UPDATE retry_jobs SET state='done',attempts=attempts+1,lease_until=NULL,last_error=NULL WHERE id=${job.id}`,
            );
            await tx.execute(
              sql`INSERT INTO audit_logs VALUES (${randomUUID()},${job.tenant_id},${job.property_id},'system','retry.success',${job.id},now())`,
            );
            await tx.execute(
              sql`INSERT INTO integration_logs(id,tenant_id,property_id,operation,status,latency,classification,correlation_id) VALUES (${randomUUID()},${job.tenant_id},${job.property_id},${job.operation},${result.status},${Date.now() - started},${c.mode === "demo" ? "demo" : "success"},${correlation})`,
            );
            await appendEvent(
              tx,
              job.tenant_id,
              job.property_id,
              "reservations",
            );
            await appendEvent(
              tx,
              job.tenant_id,
              job.property_id,
              "integrations",
            );
          });
        } catch (error) {
          const e =
            error instanceof OhipError
              ? error
              : new OhipError(
                  0,
                  error instanceof TypeError ? "network" : "contract",
                );
          const attempts = job.attempts + 1;
          const retry =
            [0, 429, 500, 502, 503, 504].includes(e.status) &&
            attempts < job.max_attempts;
          await db.orm.transaction(async (tx) => {
            await tx.execute(
              sql`UPDATE retry_jobs SET state=${retry ? "queued" : "dead"},attempts=${attempts},next_at=now()+${Math.max(backoff(attempts), e.retryAfter)}*interval '1 millisecond',last_error=${e.classification},lease_until=NULL WHERE id=${job.id}`,
            );
            if (e.classification !== "connection_changed")
              await tx.execute(
                sql`UPDATE connections SET status='degraded' WHERE tenant_id=${job.tenant_id} AND property_id=${job.property_id}`,
              );
            await tx.execute(
              sql`INSERT INTO integration_logs(id,tenant_id,property_id,operation,status,latency,classification,correlation_id) VALUES (${randomUUID()},${job.tenant_id},${job.property_id},${job.operation},${e.status},${Date.now() - started},${e.classification || classify(e.status)},${correlation})`,
            );
            await tx.execute(
              sql`INSERT INTO audit_logs VALUES (${randomUUID()},${job.tenant_id},${job.property_id},'system','retry.attempt',${job.id},now())`,
            );
            await appendEvent(
              tx,
              job.tenant_id,
              job.property_id,
              "integrations",
            );
          });
        }
      }
    } finally {
      busy = false;
    }
  }
  return { tick };
}
