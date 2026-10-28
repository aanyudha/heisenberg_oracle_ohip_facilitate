import { z } from "zod";
import type { Reservation } from "@hospitality/contracts";
import { decrypt } from "./security.js";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { credentials } from "./connection-store.js";
export const OCIM_SCOPE = "urn:opc:hgbu:ws:__myscopes__";
type TokenState = {
  token: string;
  expires: number;
  refreshing: Promise<void> | null;
};
const tokenCaches = new WeakMap<object, Map<string, TokenState>>();
let nextRequestAt = 0;
export function retryAfter(response: Response) {
  const value = response.headers.get("retry-after");
  if (value === null) return 0;
  const seconds = Number(value);
  return Math.min(
    3600000,
    Math.max(
      0,
      Number.isFinite(seconds)
        ? seconds * 1000
        : Date.parse(value) - Date.now(),
    ) || 0,
  );
}
export class OhipError extends Error {
  constructor(
    public status: number,
    public classification: string,
    public retryAfter = 0,
  ) {
    super(classification);
  }
}
export const classify = (status: number) =>
  status === 401
    ? "authentication"
    : status === 403
      ? "permission"
      : status === 429
        ? "throttled"
        : status >= 500
          ? "upstream"
          : status === 0
            ? "network"
            : "contract";
const info = z.object({
  reservationIdList: z.array(z.object({ id: z.string(), type: z.string() })),
  reservationStatus: z.string(),
  roomStay: z.object({
    arrivalDate: z.iso.date(),
    departureDate: z.iso.date(),
    roomId: z.string().optional(),
  }),
  reservationGuest: z
    .object({
      givenName: z.string().optional(),
      surname: z.string().optional(),
      vip: z
        .object({
          vipCode: z.string().optional(),
          vipDescription: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export const oracleResponse = z.object({
  reservations: z.object({
    reservationInfo: z.array(info).default([]),
    hasMore: z.boolean().optional(),
  }),
});
export function mapReservations(
  payload: unknown,
): Omit<Reservation, "updated_at">[] {
  return oracleResponse.parse(payload).reservations.reservationInfo.map((r) => {
    const id = r.reservationIdList.find((i) => i.type === "Reservation")?.id;
    if (!id) throw new OhipError(422, "contract");
    return {
      id,
      confirmation:
        r.reservationIdList.find((i) => i.type === "Confirmation")?.id || id,
      guest_name:
        [r.reservationGuest?.givenName, r.reservationGuest?.surname]
          .filter(Boolean)
          .join(" ") || "Guest name unavailable",
      arrival: r.roomStay.arrivalDate,
      departure: r.roomStay.departureDate,
      status: r.reservationStatus,
      room: r.roomStay.roomId || null,
      vip: !!r.reservationGuest?.vip?.vipCode,
      source: "OHIP polling",
    };
  });
}
export interface OperationsAdapter {
  read(
    date: string,
    knownIds?: string[],
  ): Promise<{ items: Omit<Reservation, "updated_at">[]; status: number }>;
}
export type Telemetry = {
  operation: string;
  status: number;
  latency: number;
  correlationId: string;
  classification: string;
};
export class MockAdapter implements OperationsAdapter {
  async read(_date: string) {
    return { items: [], status: 200 };
  }
}
export function validateGateway(gateway: string) {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new OhipError(400, "gateway_not_allowed");
  }
  const allowed = (process.env.OHIP_ALLOWED_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !allowed.includes(url.hostname)
  )
    throw new OhipError(400, "gateway_not_allowed");
  return url.origin;
}
export class RealOhipAdapter implements OperationsAdapter {
  private state: TokenState;
  private base: string;
  private secret: {
    clientId: string;
    clientSecret: string;
    applicationKey: string;
  };
  constructor(
    private connection: Record<string, any>,
    private transport: typeof fetch = fetch,
    private telemetry?: (event: Telemetry) => Promise<void>,
  ) {
    this.base = validateGateway(connection.base_url || connection.gateway);
    if (connection.encrypted_client_secret) {
      const value = credentials(connection);
      this.secret = {
        clientId: value.clientId,
        clientSecret: value.clientSecret,
        applicationKey: value.appKey,
      };
    } else this.secret = decrypt(connection.encrypted_secret); // Compatibility for in-memory legacy adapters.
    this.state = { token: "", expires: 0, refreshing: null };
    if (
      connection.encrypted_client_secret &&
      connection.connection_id &&
      connection.tenant_id
    ) {
      let cache = tokenCaches.get(transport);
      if (!cache) {
        cache = new Map();
        tokenCaches.set(transport, cache);
      }
      const revision = createHash("sha256")
        .update(
          JSON.stringify([
            this.base,
            connection.enterprise_id,
            connection.client_id,
            connection.encrypted_client_secret,
            connection.encrypted_app_key,
          ]),
        )
        .digest("hex");
      const key = JSON.stringify([
        connection.tenant_id,
        connection.connection_id,
        revision,
      ]);
      if (cache.has(key)) this.state = cache.get(key)!;
      else {
        if (cache.size >= 500) cache.delete(cache.keys().next().value!);
        cache.set(key, this.state);
      }
    }
  }
  private async request(path: string, options: RequestInit, operation: string) {
    validateGateway(this.base);
    if (this.transport === fetch) {
      const wait = Math.max(0, nextRequestAt - Date.now());
      nextRequestAt =
        Math.max(Date.now(), nextRequestAt) +
        Math.max(250, Number(process.env.OHIP_REQUEST_INTERVAL_MS) || 250);
      if (wait) await new Promise((r) => setTimeout(r, wait));
    }
    const start = Date.now(),
      correlationId = crypto.randomUUID();
    let status = 0;
    try {
      const response = await this.transport(this.base + path, {
        ...options,
        headers: { ...options.headers, "x-request-id": correlationId },
      });
      status = response.status;
      return response;
    } catch {
      throw new OhipError(0, "network");
    } finally {
      await this.telemetry?.({
        operation,
        status,
        latency: Date.now() - start,
        correlationId,
        classification:
          status >= 200 && status < 300 ? "success" : classify(status),
      });
    }
  }
  private async authenticate() {
    if (this.state.expires > Date.now()) return;
    if (!this.state.refreshing)
      this.state.refreshing = (async () => {
        const r = await this.request(
          "/oauth/v1/tokens",
          {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            headers: {
              Authorization: `Basic ${Buffer.from(`${this.secret.clientId}:${this.secret.clientSecret}`).toString("base64")}`,
              "Content-Type": "application/x-www-form-urlencoded",
              "x-app-key": this.secret.applicationKey,
              enterpriseId: this.connection.enterprise_id,
            },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              scope: OCIM_SCOPE,
            }),
          },
          "oauth_token",
        );
        if (!r.ok)
          throw new OhipError(r.status, classify(r.status), retryAfter(r));
        const token = z
          .object({
            access_token: z.string().min(1),
            expires_in: z.coerce.number().positive().max(86400),
          })
          .parse(await r.json());
        this.state.token = token.access_token;
        this.state.expires =
          Date.now() +
          token.expires_in * 1000 -
          Math.min(60000, token.expires_in * 100);
      })().finally(() => {
        this.state.refreshing = null;
      });
    await this.state.refreshing;
  }
  private async search(body: Record<string, unknown>) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.authenticate();
      const token = this.state.token;
      const response = await this.request(
        `/rsv/v1/hotels/${encodeURIComponent(this.connection.hotel_id)}/reservations/searches`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-app-key": this.secret.applicationKey,
            "x-hotelid": this.connection.hotel_id,
          },
          body: JSON.stringify(body),
        },
        "searchHotelReservations",
      );
      if (response.status !== 401 || attempt === 1) return response;
      if (this.state.token === token) this.state.expires = 0;
    }
    throw new OhipError(401, "authentication");
  }
  async testConnection() {
    const response = await this.search({
      searchType: "Any",
      limit: 1,
      offset: 0,
    });
    if (!response.ok)
      throw new OhipError(
        response.status,
        classify(response.status),
        retryAfter(response),
      );
    if (response.status !== 204) {
      try {
        oracleResponse.parse(await response.json());
      } catch {
        throw new OhipError(422, "contract");
      }
    }
    return { status: "connected" as const };
  }
  async read(date: string, knownIds: string[] = []) {
    const items: Omit<Reservation, "updated_at">[] = [];
    if (knownIds.length > 1000)
      throw new OhipError(422, "reconciliation_limit");
    const deadline = Date.now() + 8 * 60 * 1000;
    const searches: Record<string, unknown>[] = [
      { searchType: "Arrival", arrivalStartDate: date, arrivalEndDate: date },
      {
        searchType: "Departure",
        departureStartDate: date,
        departureEndDate: date,
      },
      { searchType: "InHouse" },
    ];
    // Re-read cached operational reservations to catch reschedules/cancellations outside today's date windows.
    for (let start = 0; start < knownIds.length; start += 100)
      searches.push({
        searchType: "Any",
        reservationIdList: knownIds.slice(start, start + 100),
      });
    for (const search of searches) {
      let offset = 0;
      for (let page = 0; page < 20; page++) {
        if (Date.now() > deadline) throw new OhipError(0, "poll_deadline");
        const r = await this.search({ ...search, limit: 100, offset });
        if (r.status === 204) break;
        if (!r.ok) {
          const h = r.headers.get("retry-after");
          const seconds = Number(h);
          const wait = Number.isFinite(seconds)
            ? seconds * 1000
            : Math.max(0, Date.parse(h || "") - Date.now());
          throw new OhipError(
            r.status,
            classify(r.status),
            Math.min(3600000, wait || 0),
          );
        }
        const data = oracleResponse.parse(await r.json());
        items.push(...mapReservations(data));
        if (!data.reservations.hasMore) break;
        offset += 100;
        if (page === 19) throw new OhipError(422, "pagination_limit");
      }
    }
    return {
      items: [...new Map(items.map((i) => [i.id, i])).values()],
      status: 200,
    };
  }
}
