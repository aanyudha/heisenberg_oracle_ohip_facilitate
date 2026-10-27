import type { WebSocket } from "ws";
import type { Database } from "./db.js";
import { sql } from "./db.js";
import type { Role } from "@hospitality/contracts";
export type Principal = {
  id: string;
  tenantId: string;
  role: Role;
  developer: boolean;
  csrf: string;
  properties: string[];
  expiresAt: number;
  tokenHash: string;
};
export async function appendEvent(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  tenant: string,
  property: string | null,
  topic: string,
) {
  // Allocate sequence numbers in commit order. Otherwise a later transaction can
  // commit first and make an earlier, still-uncommitted event fall behind cursors.
  // All callers append only after their business writes and audit entries.
  await tx.execute(sql`LOCK TABLE change_events IN SHARE ROW EXCLUSIVE MODE`);
  await tx.execute(
    sql`INSERT INTO change_events(tenant_id,property_id,topic) VALUES (${tenant},${property},${topic})`,
  );
}
export function realtime(db: Database) {
  const clients = new Set<{
    socket: WebSocket;
    user: Principal;
    cursor: number;
    busy: boolean;
    alive: boolean;
  }>();
  async function reconcile(c: typeof clients extends Set<infer T> ? T : never) {
    if (c.busy) return;
    c.busy = true;
    try {
      if (c.user.expiresAt <= Date.now()) {
        c.socket.close(1008, "Session expired");
        return;
      }
      // Re-read grants: revocation applies to established sockets too.
      const memberships = await db.query(
        sql`SELECT m.role FROM memberships m JOIN sessions s ON s.tenant_id=m.tenant_id AND s.user_id=m.user_id WHERE m.tenant_id=${c.user.tenantId} AND m.user_id=${c.user.id} AND s.token_hash=${c.user.tokenHash} AND s.expires_at>now()`,
      );
      if (!memberships.length) {
        c.socket.close(1008, "Access revoked");
        return;
      }
      const grants = (
        await db.query(
          sql`SELECT property_id FROM property_grants WHERE tenant_id=${c.user.tenantId} AND user_id=${c.user.id}`,
        )
      ).map((r) => r.property_id);
      const high = Number(
        (
          await db.query(
            sql`SELECT coalesce(max(seq),0) AS seq FROM change_events WHERE tenant_id=${c.user.tenantId} AND (property_id IS NULL OR property_id IN (${
              grants.length
                ? sql.join(
                    grants.map((p) => sql`${p}`),
                    sql`, `,
                  )
                : sql`NULL`
            }))`,
          )
        )[0].seq,
      );
      const events = await db.query(
        sql`SELECT seq,property_id,topic,created_at FROM change_events WHERE tenant_id=${c.user.tenantId} AND seq>${c.cursor} AND seq<=${high} AND (property_id IS NULL OR property_id IN (${
          grants.length
            ? sql.join(
                grants.map((p) => sql`${p}`),
                sql`, `,
              )
            : sql`NULL`
        })) ORDER BY seq LIMIT 101`,
      );
      if (events.length > 100)
        c.socket.send(JSON.stringify({ topic: "reconcile", seq: high }));
      else
        for (const e of events)
          c.socket.send(
            JSON.stringify({
              seq: Number(e.seq),
              propertyId: e.property_id,
              topic: e.topic,
              at: e.created_at,
            }),
          );
      c.cursor = high;
      c.socket.send(
        JSON.stringify({
          topic: "heartbeat",
          seq: high,
          at: new Date().toISOString(),
        }),
      );
    } finally {
      c.busy = false;
    }
  }
  const timer = setInterval(() => {
    for (const c of clients)
      reconcile(c).catch(() => c.socket.close(1011, "Reconciliation failed"));
  }, 1000);
  timer.unref();
  const pingTimer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive || c.socket.bufferedAmount > 65536) {
        c.socket.terminate();
        continue;
      }
      c.alive = false;
      c.socket.ping();
    }
  }, 15000);
  pingTimer.unref();
  return {
    async add(socket: WebSocket, user: Principal, cursor: number) {
      const c = { socket, user, cursor, busy: false, alive: true };
      socket.on("pong", () => {
        c.alive = true;
      });
      clients.add(c);
      socket.on("close", () => clients.delete(c));
      socket.on("error", () => clients.delete(c));
      await reconcile(c);
    },
    close() {
      clearInterval(timer);
      clearInterval(pingTimer);
      for (const c of clients) c.socket.close(1001);
    },
  };
}
