import { z } from "zod";
import { validateGateway } from "./ohip-gateway.js";
import { createHash, randomUUID } from "node:crypto";
export const OCIM_SCOPE = "urn:opc:hgbu:ws:__myscopes__";
export const POLICY_CODE = "OHIP_READ_ONLY_POLICY";
export class OhipReadOnlyError extends Error {
  readonly statusCode = 403;
  readonly classification = POLICY_CODE;
  constructor() {
    super(POLICY_CODE);
  }
}
export type OhipScope = {
  tenantId: string;
  propertyId: string;
  connectionId: string;
  hotelId: string;
  authorize: () => Promise<boolean>;
  cacheTtlMs?: number;
  dispatch?: (send: () => Promise<Response>) => Promise<Response>;
};
export type OhipRoute = {
  tenant_id: string;
  property_id: string;
  connection_id: string;
  hotel_id: string;
  enterprise_id: string;
  [key: string]: any;
};
export type HttpAudit = {
  operation: string;
  status: number;
  latency: number;
  correlationId: string;
  classification: string;
};
export const APPROVED_OHIP_OPERATIONS = Object.freeze({
  searchHotelReservations: Object.freeze({
    method: "POST",
    path: "/rsv/v1/hotels/{hotelId}/reservations/searches",
    semantics: "bounded reservation search",
  }),
  getReservation: Object.freeze({
    method: "GET",
    path: "/rsv/v1/hotels/{hotelId}/reservations/{reservationId}?markAsRecentlyAccessed=false&includeInSession=false",
    semantics: "retrieve only; no recent-access or session side effects",
  }),
  oauth_token: Object.freeze({
    method: "POST",
    path: "/oauth/v1/tokens",
    semantics:
      "OCIM client_credentials authentication only; local alias for Oracle's named OAuth request",
  }),
});
const searchSchema = z.strictObject({
  searchType: z.enum(["Arrival", "Departure", "InHouse", "Any"]),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(1900),
  arrivalStartDate: z.iso.date().optional(),
  arrivalEndDate: z.iso.date().optional(),
  departureStartDate: z.iso.date().optional(),
  departureEndDate: z.iso.date().optional(),
  reservationIdList: z
    .array(z.string().min(1).max(2000))
    .min(1)
    .max(100)
    .optional(),
});
export function assertReadOnlyConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (
    (environment.OHIP_ACCESS_MODE ?? "read_only") !== "read_only" ||
    (environment.OHIP_MUTATIONS_ENABLED ?? "false") !== "false"
  )
    throw new OhipReadOnlyError();
}
export async function enforceOhipPolicy(
  operation: string,
  path: string,
  options: RequestInit,
  route: OhipRoute,
  scope: OhipScope,
) {
  const deny = () => {
    throw new OhipReadOnlyError();
  };
  assertReadOnlyConfiguration();
  if (!Object.hasOwn(APPROVED_OHIP_OPERATIONS, operation)) deny();
  if (
    !scope ||
    ![
      scope.tenantId,
      scope.propertyId,
      scope.connectionId,
      scope.hotelId,
    ].every((v) => typeof v === "string" && v.length > 0) ||
    typeof scope.authorize !== "function"
  )
    deny();
  if (
    scope.tenantId !== route.tenant_id ||
    scope.propertyId !== route.property_id ||
    scope.connectionId !== route.connection_id ||
    scope.hotelId !== route.hotel_id
  )
    deny();
  if (
    !/^[A-Za-z0-9_.-]{1,40}$/.test(scope.hotelId) ||
    scope.hotelId === "." ||
    scope.hotelId === ".."
  )
    deny();
  const rule =
    APPROVED_OHIP_OPERATIONS[
      operation as keyof typeof APPROVED_OHIP_OPERATIONS
    ];
  if (options.method !== rule.method || options.redirect !== "error") deny();
  if (
    Object.keys(options).some(
      (k) => !["method", "headers", "body", "redirect", "signal"].includes(k),
    )
  )
    deny();
  let headers: Headers;
  try {
    headers = new Headers(options.headers);
  } catch {
    deny();
  }
  const allowedHeaders =
    operation === "oauth_token"
      ? [
          "authorization",
          "content-type",
          "x-app-key",
          "enterpriseid",
          "x-request-id",
        ]
      : [
          "authorization",
          "content-type",
          "accept",
          "x-app-key",
          "x-hotelid",
          "x-request-id",
        ];
  if (
    [...headers!.keys()].some((k) => !allowedHeaders.includes(k)) ||
    !headers!.get("x-app-key")
  )
    deny();
  if (operation === "oauth_token") {
    if (
      path !== "/oauth/v1/tokens" ||
      headers!.get("enterpriseid") !== route.enterprise_id ||
      !/^Basic [A-Za-z0-9+/]+=*$/.test(headers!.get("authorization") || "") ||
      headers!.get("content-type") !== "application/x-www-form-urlencoded" ||
      !(options.body instanceof URLSearchParams)
    )
      deny();
    const body = options.body as URLSearchParams;
    if (
      [...body.keys()].sort().join(",") !== "grant_type,scope" ||
      body.get("grant_type") !== "client_credentials" ||
      body.get("scope") !== OCIM_SCOPE
    )
      deny();
  } else {
    if (
      headers!.get("x-hotelid") !== scope.hotelId ||
      !/^Bearer [^\s]+$/.test(headers!.get("authorization") || "")
    )
      deny();
    const base = `/rsv/v1/hotels/${encodeURIComponent(scope.hotelId)}/reservations`;
    if (operation === "getReservation") {
      const [pathname, query] = path.split("?");
      if (
        path.split("?").length !== 2 ||
        !new RegExp(
          "^" +
            base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "/[A-Za-z0-9_-]{1,80}$",
        ).test(pathname) ||
        pathname.endsWith("/searches") ||
        options.body !== undefined
      )
        deny();
      const params = new URLSearchParams(query);
      if (
        [...params.keys()].sort().join(",") !==
          "includeInSession,markAsRecentlyAccessed" ||
        params.get("markAsRecentlyAccessed") !== "false" ||
        params.get("includeInSession") !== "false"
      )
        deny();
    } else {
      if (
        path !== base + "/searches" ||
        headers!.get("content-type") !== "application/json" ||
        typeof options.body !== "string"
      )
        deny();
      let parsed: ReturnType<typeof searchSchema.safeParse>;
      try {
        parsed = searchSchema.safeParse(JSON.parse(options.body as string));
      } catch {
        deny();
      }
      if (!parsed!.success) deny();
      const b = parsed!.data!;
      if (
        b.searchType === "Arrival" &&
        (!b.arrivalStartDate ||
          b.arrivalEndDate !== b.arrivalStartDate ||
          b.departureStartDate ||
          b.departureEndDate ||
          b.reservationIdList)
      )
        deny();
      if (
        b.searchType === "Departure" &&
        (!b.departureStartDate ||
          b.departureEndDate !== b.departureStartDate ||
          b.arrivalStartDate ||
          b.arrivalEndDate ||
          b.reservationIdList)
      )
        deny();
      if (
        ["InHouse", "Any"].includes(b.searchType) &&
        (b.arrivalStartDate ||
          b.arrivalEndDate ||
          b.departureStartDate ||
          b.departureEndDate)
      )
        deny();
      if (b.searchType === "InHouse" && b.reservationIdList) deny();
      if (
        b.searchType === "Any" &&
        !b.reservationIdList &&
        (b.limit !== 1 || b.offset !== 0)
      )
        deny();
    }
  }
  let authorized = false;
  try {
    authorized = await scope.authorize();
  } catch {
    /* Fail closed without exposing database errors. */
  }
  if (authorized !== true) deny();
}
let nextRequestAt = 0;
type Cached = {
  expires: number;
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
};
const caches = new WeakMap<typeof fetch, Map<string, Cached>>(),
  pending = new WeakMap<typeof fetch, Map<string, Promise<Cached>>>();
function response(c: Cached) {
  return new Response(c.status === 204 ? null : c.body.slice(0), {
    status: c.status,
    headers: c.headers,
  });
}
export class OhipHttpClient {
  constructor(
    private route: OhipRoute,
    private scope: OhipScope,
    private transport: typeof fetch,
    private audit: ((e: HttpAudit) => Promise<void>) | undefined,
  ) {
    this.route = Object.freeze({ ...route });
    this.scope = Object.freeze({ ...scope });
  }
  async request(
    base: string,
    path: string,
    options: RequestInit,
    operation: string,
  ): Promise<Response> {
    const correlationId = randomUUID(),
      started = Date.now();
    options = {
      ...options,
      headers: { ...options.headers },
      body:
        options.body instanceof URLSearchParams
          ? new URLSearchParams(options.body)
          : options.body,
    };
    try {
      base = validateGateway(base);
      const assignedBase = this.route.base_url || this.route.gateway;
      if (
        typeof assignedBase !== "string" ||
        validateGateway(assignedBase) !== base
      )
        throw new OhipReadOnlyError();
      await enforceOhipPolicy(operation, path, options, this.route, this.scope);
      if (this.transport === fetch && (!this.audit || !this.scope.dispatch))
        throw new OhipReadOnlyError();
    } catch (error) {
      await this.audit?.({
        operation: Object.hasOwn(APPROVED_OHIP_OPERATIONS, operation)
          ? operation
          : "blocked_operation",
        status: 403,
        latency: Date.now() - started,
        correlationId,
        classification: POLICY_CODE,
      });
      throw error;
    }
    const ttl =
      operation === "oauth_token"
        ? 0
        : Math.min(5000, Math.max(0, this.scope.cacheTtlMs || 0));
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          this.scope.tenantId,
          this.scope.propertyId,
          this.scope.connectionId,
          this.scope.hotelId,
          this.route.client_id,
          this.route.enterprise_id,
          this.route.credential_revision,
          this.route.encrypted_client_secret,
          this.route.encrypted_app_key,
          base,
          path,
          operation,
          String(options.body || ""),
        ]),
      )
      .digest("hex");
    let cache = caches.get(this.transport),
      inFlight = pending.get(this.transport);
    if (!cache) {
      cache = new Map();
      caches.set(this.transport, cache);
    }
    if (!inFlight) {
      inFlight = new Map();
      pending.set(this.transport, inFlight);
    }
    if (ttl) {
      const hit = cache.get(key);
      if (hit && hit.expires > Date.now()) return response(hit);
      const running = inFlight.get(key);
      if (running) return response(await running);
    }
    const send = async () => {
      if (this.transport === fetch) {
        const wait = Math.max(0, nextRequestAt - Date.now());
        nextRequestAt =
          Math.max(Date.now(), nextRequestAt) +
          Math.max(250, Number(process.env.OHIP_REQUEST_INTERVAL_MS) || 250);
        if (wait) await new Promise((r) => setTimeout(r, wait));
      }
      let status = 0;
      try {
        validateGateway(base);
        await enforceOhipPolicy(
          operation,
          path,
          options,
          this.route,
          this.scope,
        );
        const dispatch = () =>
          this.transport(base + path, {
            ...options,
            headers: { ...options.headers, "x-request-id": correlationId },
          });
        const r = await (this.scope.dispatch
          ? this.scope.dispatch(dispatch)
          : dispatch());
        status = r.status;
        return r;
      } catch (error) {
        if (error instanceof OhipReadOnlyError) status = 403;
        throw error;
      } finally {
        await this.audit?.({
          operation,
          status,
          latency: Date.now() - started,
          correlationId,
          classification:
            status >= 200 && status < 300
              ? "success"
              : status === 0
                ? "network"
                : status === 401
                  ? "authentication"
                  : status === 403
                    ? "permission"
                    : status === 429
                      ? "throttled"
                      : status >= 500
                        ? "upstream"
                        : "contract",
        });
      }
    };
    if (!ttl) return send();
    const work = (async () => {
      const r = await send(),
        entry: Cached = {
          expires: Date.now() + ttl,
          status: r.status,
          headers: [...r.headers.entries()],
          body: await r.arrayBuffer(),
        };
      if (r.ok && entry.body.byteLength <= 2 * 1024 * 1024) {
        if (cache!.size >= 100) cache!.delete(cache!.keys().next().value!);
        cache!.set(key, entry);
      }
      return entry;
    })();
    inFlight.set(key, work);
    try {
      return response(await work);
    } finally {
      inFlight.delete(key);
    }
  }
}
export function blockedOracleApi(method: string, url: string) {
  const path = url.split("?")[0];
  if (
    /^\/api\/(?:ohip|ohip-proxy|ohip-explorer|api-explorer|explorer|oracle|proxy|graphql|rsv|crm|hsk|fof|htl)(?:\/|$)/i.test(
      path,
    )
  )
    return true;
  return (
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    /^\/api\/(?:reservations|guest-profiles|profiles|housekeeping|rates|inventory|availability|payments|charges|reports)(?:\/|$)/i.test(
      path,
    )
  );
}
