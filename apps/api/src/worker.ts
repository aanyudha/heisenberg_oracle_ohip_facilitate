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
    if (existing && existing.secret === c.encrypted_secret)
      return existing.adapter;
    const a =
      c.mode === "demo"
        ? new MockAdapter()
        : new RealOhipAdapter(c, fetch, async (e) => {
            await db.query(
              sql`INSERT INTO integration_logs(id,tenant_id,property_id,operation,status,latency,classification,correlation_id) VALUES (${randomUUID()},${c.tenant_id},${c.property_id},${e.operation},${e.status},${e.latency},${e.classification},${e.correlationId})`,
            );
          });
    adapters.set(c.id, { secret: c.encrypted_secret, adapter: a });
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
        sql`UPDATE connections SET lease_until=now()+interval '15 minutes',next_poll=now()+${Math.max(30000, Number(process.env.POLL_INTERVAL_MS) || 60000)}*interval '1 millisecond' WHERE id IN (SELECT id FROM connections WHERE next_poll<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_poll LIMIT 5 FOR UPDATE SKIP LOCKED) RETURNING *`,
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
            sql`SELECT c.*,p.timezone FROM connections c JOIN properties p ON p.id=c.property_id WHERE c.tenant_id=${job.tenant_id} AND c.property_id=${job.property_id}`,
          )
        )[0];
        const started = Date.now(),
          correlation = randomUUID();
        try {
          if (!c || !retrySafe(job.operation))
            throw new OhipError(400, "unsafe_operation");
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
