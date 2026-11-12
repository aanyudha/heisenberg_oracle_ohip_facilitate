import { createHash, randomUUID } from "node:crypto";
import type { WorksheetRoom } from "@hospitality/contracts";
import { sql, type Database } from "./db.js";
import { RealOhipAdapter, OhipError } from "./ohip.js";
import { connectionDispatch } from "./connection-control.js";
import { appendEvent } from "./realtime.js";

export type RoomFeed = {
  binding?: string;
  source: "OHIP" | "DEMO";
  available: boolean;
  status: string;
  error: string | null;
  taskError: string | null;
  syncedAt: string | null;
  rooms: WorksheetRoom[];
};
export async function roomConnection(
  db: Database,
  tenant: string,
  property: string,
) {
  return (
    await db.query(
      sql`SELECT c.mode,c.status,p.timezone,m.control_revision,m.hotel_id,m.validation_status,m.paused AS property_paused,o.id AS connection_id,o.paused,o.archived_at,o.base_url,o.client_id,o.encrypted_client_secret,o.encrypted_app_key,o.enterprise_id,o.updated_at::text AS credential_revision FROM properties p LEFT JOIN connections c ON c.tenant_id=p.tenant_id AND c.property_id=p.id LEFT JOIN ohip_connection_properties m ON m.tenant_id=p.tenant_id AND m.property_id=p.id LEFT JOIN ohip_connections o ON o.tenant_id=m.tenant_id AND o.id=m.connection_id WHERE p.tenant_id=${tenant} AND p.id=${property}`,
    )
  )[0];
}
export const housekeepingBinding = (c: Record<string, any>) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        c.connection_id,
        c.hotel_id,
        c.control_revision,
        c.credential_revision,
      ]),
    )
    .digest("hex");
export function housekeepingFeed(
  db: Database,
  transport: typeof fetch = fetch,
) {
  const pending = new Map<string, Promise<RoomFeed>>();
  async function read(
    tenant: string,
    property: string,
    date: string,
  ): Promise<RoomFeed> {
    const c = await roomConnection(db, tenant, property);
    const empty = (status: string, error: string): RoomFeed => ({
      source: "OHIP",
      available: false,
      status,
      error,
      taskError: null,
      syncedAt: null,
      rooms: [],
    });
    if (c?.mode === "demo") {
      const rows = await db.query(
        sql`SELECT r.id,r.status,r.attention,r.updated_at,d.floor,d.section,d.departure_credits,d.stayover_credits,d.other_credits,d.credits_configured FROM rooms r LEFT JOIN housekeeping_room_directory d ON d.tenant_id=r.tenant_id AND d.property_id=r.property_id AND d.room_id=r.id WHERE r.tenant_id=${tenant} AND r.property_id=${property} ORDER BY r.id`,
      );
      const reservations = await db.query(
        sql`SELECT room,arrival::text,departure::text,status,vip FROM reservations WHERE tenant_id=${tenant} AND property_id=${property} AND status NOT IN ('Cancelled','NoShow')`,
      );
      return {
        source: "DEMO",
        available: rows.length > 0,
        status: "demo",
        error: null,
        taskError: null,
        syncedAt: null,
        rooms: rows.map((r) => {
          const stays = reservations.filter((v) => v.room === r.id);
          const day = (v: any) => String(v).slice(0, 10);
          const departure = stays.some((v) => day(v.departure) === date),
            arrival = stays.some((v) => day(v.arrival) === date),
            stayover =
              !departure &&
              stays.some(
                (v) =>
                  day(v.arrival) <= date &&
                  day(v.departure) > date &&
                  ["InHouse", "DueOut"].includes(v.status),
              );
          const status = String(r.status).replaceAll("_", "").toLowerCase(),
            s =
              (
                {
                  dirty: "Dirty",
                  clean: "Clean",
                  inspected: "Inspected",
                  outoforder: "OutOfOrder",
                  outofservice: "OutOfService",
                  pickup: "Pickup",
                } as Record<string, string>
              )[status] || String(r.status);
          const dnd = /DND|DoNotDisturb/i.test(r.attention),
            vip = stays.some(
              (v) =>
                v.vip && day(v.arrival) <= date && day(v.departure) >= date,
            );
          return {
            id: r.id,
            floor: r.floor || null,
            floorSource: r.floor ? "local_validated" : "unavailable",
            section: r.section || null,
            roomType: null,
            status: s,
            departure,
            stayover,
            arrival,
            vip,
            dnd,
            makeUpRoom: false,
            outOfOrder: s === "OutOfOrder",
            outOfService: s === "OutOfService",
            priority: vip || departure,
            tasks: [],
            remarks: r.attention ? [r.attention] : [],
            credits: r.credits_configured
              ? Number(
                  r[
                    departure
                      ? "departure_credits"
                      : stayover
                        ? "stayover_credits"
                        : "other_credits"
                  ],
                )
              : null,
            creditSource: r.credits_configured ? "local" : "not_configured",
            observedAt: new Date(r.updated_at).toISOString(),
          } as WorksheetRoom;
        }),
      };
    }
    if (!c?.connection_id || c.validation_status !== "validated")
      return empty(
        "not_connected",
        "No authorized OPERA room feed. Configure and validate this property connection.",
      );
    if (c.paused || c.property_paused || c.archived_at)
      return empty(
        "paused",
        "OPERA connection is paused or archived. Existing local assignments are retained.",
      );
    const key = housekeepingBinding(c);
    const cached = (
      await db.query(
        sql`SELECT * FROM housekeeping_room_feeds WHERE tenant_id=${tenant} AND property_id=${property} AND business_date=${date} AND binding=${key}`,
      )
    )[0];
    if (cached && Date.now() - new Date(cached.attempted_at).getTime() < 30000)
      return {
        binding: key,
        source: "OHIP",
        available: cached.status === "synced" && cached.rooms.length > 0,
        status: cached.status,
        error: cached.error,
        taskError: cached.task_error,
        syncedAt: cached.synced_at
          ? new Date(cached.synced_at).toISOString()
          : null,
        rooms: cached.status === "synced" ? cached.rooms : [],
      };
    const scope = {
      tenantId: tenant,
      propertyId: property,
      connectionId: c.connection_id,
      hotelId: c.hotel_id,
      authorize: async () => {
        const fresh = await roomConnection(db, tenant, property);
        const archived = (
          await db.query(
            sql`SELECT 1 FROM local_archives WHERE tenant_id=${tenant} AND (kind='tenants' OR (kind='properties' AND target=${property}))`,
          )
        ).length;
        return (
          !archived &&
          !!fresh &&
          housekeepingBinding(fresh) === key &&
          fresh.validation_status === "validated" &&
          !fresh.paused &&
          !fresh.property_paused &&
          !fresh.archived_at &&
          fresh.mode === "real"
        );
      },
      dispatch: connectionDispatch(db, tenant, property, c.connection_id, {
        credentialRevision: c.credential_revision,
        assignmentRevision: String(c.control_revision),
        hotelId: c.hotel_id,
      }),
    };
    const adapter = new RealOhipAdapter(
      { ...c, tenant_id: tenant, property_id: property },
      transport,
      async (e) => {
        await db.query(
          sql`INSERT INTO integration_logs(id,tenant_id,property_id,operation,status,latency,classification,correlation_id) VALUES (${randomUUID()},${tenant},${property},${e.operation},${e.status},${e.latency},${e.classification},${e.correlationId})`,
        );
      },
      scope,
    );
    let result: RoomFeed;
    try {
      const data = await adapter.readHousekeeping(date);
      const now = new Date().toISOString();
      result = {
        binding: key,
        source: "OHIP",
        available: data.rooms.length > 0,
        status: "synced",
        error: data.rooms.length
          ? null
          : "OPERA returned no housekeeping rooms for this property.",
        taskError: data.taskError,
        syncedAt: now,
        rooms: data.rooms.map((r) => ({ ...r, observedAt: now })),
      };
    } catch (error) {
      const e = error as { classification?: string; status?: number };
      result = empty(
        "error",
        e.status === 401 || e.status === 403
          ? "OPERA housekeeping access denied. Check the application authorization for this property."
          : `OPERA room feed unavailable (${e.classification || "contract"}). No synthetic rooms have been created.`,
      );
      result.syncedAt = cached?.synced_at
        ? new Date(cached.synced_at).toISOString()
        : null;
    }
    await db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenant},7291043001))`,
      );
      const fresh = await roomConnection(
        { ...db, query: async (q) => (await tx.execute(q)).rows } as Database,
        tenant,
        property,
      );
      if (
        !fresh ||
        housekeepingBinding(fresh) !== key ||
        fresh.paused ||
        fresh.property_paused ||
        fresh.archived_at ||
        fresh.mode !== "real"
      )
        throw new OhipError(409, "connection_changed");
      const changed =
        !cached ||
        JSON.stringify(cached.rooms) !== JSON.stringify(result.rooms) ||
        cached.status !== result.status ||
        cached.error !== result.error;
      await tx.execute(
        sql`INSERT INTO housekeeping_room_feeds(tenant_id,property_id,business_date,binding,status,error,task_error,rooms,synced_at) VALUES (${tenant},${property},${date},${key},${result.status},${result.error},${result.taskError},${JSON.stringify(result.rooms)}::jsonb,${result.syncedAt}) ON CONFLICT(tenant_id,property_id,business_date) DO UPDATE SET binding=excluded.binding,status=excluded.status,error=excluded.error,task_error=excluded.task_error,rooms=excluded.rooms,synced_at=excluded.synced_at,attempted_at=now()`,
      );
      if (changed) await appendEvent(tx, tenant, property, "rooms");
    });
    return result;
  }
  return {
    read(tenant: string, property: string, date: string) {
      const key = JSON.stringify([tenant, property, date]);
      const current = pending.get(key);
      if (current) return current;
      const work = read(tenant, property, date).finally(() =>
        pending.delete(key),
      );
      pending.set(key, work);
      return work;
    },
  };
}
