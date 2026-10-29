import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  OhipHttpClient,
  OhipReadOnlyError,
  enforceOhipPolicy,
  POLICY_CODE,
  OCIM_SCOPE,
  APPROVED_OHIP_OPERATIONS,
  type OhipRoute,
  type OhipScope,
} from "../apps/api/src/ohip-policy";
import { loadConfig } from "../apps/api/src/config";
const base = "https://gateway.example.oraclecloud.com",
  path = "/rsv/v1/hotels/HOTEL1/reservations/searches";
const route: OhipRoute = {
  base_url: base,
  tenant_id: "tenant-a",
  property_id: "property-a",
  connection_id: "connection-a",
  hotel_id: "HOTEL1",
  enterprise_id: "ENTERPRISE",
  encrypted_client_secret: "cipher-a",
  encrypted_app_key: "cipher-key",
};
const scope = (): OhipScope => ({
  tenantId: "tenant-a",
  propertyId: "property-a",
  connectionId: "connection-a",
  hotelId: "HOTEL1",
  authorize: vi.fn(async () => true),
});
const search = (): RequestInit => ({
  method: "POST",
  redirect: "error",
  headers: {
    Authorization: "Bearer token",
    "Content-Type": "application/json",
    "x-app-key": "private-app-key",
    "x-hotelid": "HOTEL1",
  },
  body: JSON.stringify({
    searchType: "Arrival",
    arrivalStartDate: "2026-10-28",
    arrivalEndDate: "2026-10-28",
    limit: 100,
    offset: 0,
  }),
});
beforeEach(() => {
  process.env.OHIP_ALLOWED_HOSTS = "gateway.example.oraclecloud.com";
  delete process.env.OHIP_ACCESS_MODE;
  delete process.env.OHIP_MUTATIONS_ENABLED;
});
afterEach(() => {
  delete process.env.OHIP_ACCESS_MODE;
  delete process.env.OHIP_MUTATIONS_ENABLED;
  vi.useRealTimers();
});
describe("strict OHIP read-only policy", () => {
  it("requires the persistent connection dispatch guard for the default outbound transport", async () => {
    const transport = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", transport);
    try {
      const audit = vi.fn(async () => {});
      const client = new OhipHttpClient(route, scope(), fetch, audit);
      await expect(
        client.request(base, path, search(), "searchHotelReservations"),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(transport).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ classification: POLICY_CODE, status: 403 }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("locks configuration defaults and rejects every attempted enable/write value", () => {
    const env = {
      APP_MODE: "native",
      APP_URL: "http://localhost:3000",
      NODE_ENV: "test",
    };
    expect(loadConfig(env)).toMatchObject({
      ohipAccessMode: "read_only",
      ohipMutationsEnabled: "false",
    });
    for (const extra of [
      { OHIP_ACCESS_MODE: "read_write" },
      { OHIP_ACCESS_MODE: "admin" },
      { OHIP_MUTATIONS_ENABLED: "true" },
      { OHIP_ACCESS_MODE: "" },
    ])
      expect(() => loadConfig({ ...env, ...extra })).toThrow();
  });
  it("approves exact read-only POST, OAuth authentication and audited GET semantics", async () => {
    const transport = vi.fn(async () => Response.json({ ok: true })),
      audit = vi.fn(async (_event: any) => {}),
      client = new OhipHttpClient(
        route,
        scope(),
        transport as typeof fetch,
        audit,
      );
    await client.request(base, path, search(), "searchHotelReservations");
    await client.request(
      base,
      "/rsv/v1/hotels/HOTEL1/reservations/123?markAsRecentlyAccessed=false&includeInSession=false",
      { ...search(), method: "GET", body: undefined },
      "getReservation",
    );
    await client.request(
      base,
      "/oauth/v1/tokens",
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Basic Y2xpZW50OnNlY3JldA==",
          "Content-Type": "application/x-www-form-urlencoded",
          "x-app-key": "private-key",
          enterpriseId: "ENTERPRISE",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          scope: OCIM_SCOPE,
        }),
      },
      "oauth_token",
    );
    expect(transport).toHaveBeenCalledTimes(3);
    expect(audit).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(
      /private-key|private-app-key|secret|Bearer|123|HOTEL1/,
    );
    for (const [index, call] of transport.mock.calls.entries())
      expect((call as any)[1].headers["x-request-id"]).toBe(
        audit.mock.calls[index][0].correlationId,
      );
  });
  it.each([
    ["unknown", "GET", "/rsv/v1/hotels/HOTEL1/reservations/123"],
    ["postReservation", "POST", "/rsv/v1/hotels/HOTEL1/reservations"],
    [
      "cancelReservation",
      "POST",
      "/rsv/v1/hotels/HOTEL1/reservations/123/cancellations",
    ],
    ["checkIn", "POST", "/fof/v1/hotels/HOTEL1/reservations/123/checkIns"],
    ["checkOut", "POST", "/fof/v1/hotels/HOTEL1/reservations/123/checkOuts"],
    ["putProfile", "PUT", "/crm/v1/profiles/123"],
    ["putHousekeepingRoom", "PUT", "/hsk/v1/hotels/HOTEL1/rooms/123"],
    ["assignRoom", "POST", "/fof/v1/hotels/HOTEL1/roomAssignments"],
    ["postPayment", "POST", "/csh/v1/hotels/HOTEL1/payments"],
    ["updateRate", "PATCH", "/rtp/v1/hotels/HOTEL1/rates"],
    ["mutation", "POST", "/rna/v1/graphql"],
    [
      "searchHotelReservations",
      "DELETE",
      "/rsv/v1/hotels/HOTEL1/reservations/searches",
    ],
  ])("rejects %s before any transport call", async (operation, method, url) => {
    const transport = vi.fn(),
      audit = vi.fn(async (_event: any) => {}),
      client = new OhipHttpClient(
        route,
        scope(),
        transport as typeof fetch,
        audit,
      );
    await expect(
      client.request(base, url, { ...search(), method }, operation),
    ).rejects.toMatchObject({ statusCode: 403, message: POLICY_CODE });
    expect(transport).not.toHaveBeenCalled();
    expect(audit.mock.calls[0][0].classification).toBe(POLICY_CODE);
  });
  it("rejects state-affecting GET parameters, unknown fields, paths, method overrides and GraphQL in a search body", async () => {
    const variants: [string, RequestInit, string][] = [
      [
        "/rsv/v1/hotels/HOTEL1/reservations/123?markAsRecentlyAccessed=true&includeInSession=false",
        { ...search(), method: "GET", body: undefined },
        "getReservation",
      ],
      [
        "/rsv/v1/hotels/HOTEL1/reservations/123",
        { ...search(), method: "GET", body: undefined },
        "getReservation",
      ],
      [
        path,
        {
          ...search(),
          headers: {
            ...(search().headers as any),
            "X-HTTP-Method-Override": "DELETE",
          },
        },
        "searchHotelReservations",
      ],
      [
        path,
        {
          ...search(),
          body: JSON.stringify({
            searchType: "Any",
            limit: 1,
            offset: 0,
            mutation: "cancel",
          }),
        },
        "searchHotelReservations",
      ],
      [
        path,
        {
          ...search(),
          body: JSON.stringify({ query: "mutation { cancelReservation }" }),
        },
        "searchHotelReservations",
      ],
      [
        "/rsv/v1/hotels/OTHER/reservations/searches",
        search(),
        "searchHotelReservations",
      ],
      [path + "?method=DELETE", search(), "searchHotelReservations"],
      [path, { ...search(), redirect: "follow" }, "searchHotelReservations"],
    ];
    const transport = vi.fn(),
      client = new OhipHttpClient(
        route,
        scope(),
        transport as typeof fetch,
        undefined,
      );
    for (const [url, options, operation] of variants)
      await expect(
        client.request(base, url, options, operation),
      ).rejects.toBeInstanceOf(OhipReadOnlyError);
    expect(transport).not.toHaveBeenCalled();
  });
  it("fails closed for cross-tenant/property scope, missing proof, rejected proof and runtime env bypasses", async () => {
    for (const override of [
      { tenantId: "other-tenant" },
      { propertyId: "other-property" },
      { hotelId: "OTHER" },
      { connectionId: "other-connection" },
      { authorize: undefined },
      { authorize: async () => false },
    ])
      await expect(
        enforceOhipPolicy("searchHotelReservations", path, search(), route, {
          ...scope(),
          ...override,
        } as any),
      ).rejects.toMatchObject({ statusCode: 403 });
    const transport = vi.fn(),
      client = new OhipHttpClient(
        route,
        scope(),
        transport as typeof fetch,
        undefined,
      );
    process.env.OHIP_MUTATIONS_ENABLED = "true";
    await expect(
      client.request(base, path, search(), "searchHotelReservations"),
    ).rejects.toMatchObject({ message: POLICY_CODE });
    expect(transport).not.toHaveBeenCalled();
  });
  it("deduplicates/caches scoped responses and rechecks authorization before a cache hit", async () => {
    const authorize = vi.fn(async () => true),
      transport = vi.fn(async () =>
        Response.json({
          reservations: { reservationInfo: [], hasMore: false },
        }),
      ),
      client = new OhipHttpClient(
        route,
        { ...scope(), authorize, cacheTtlMs: 5000 },
        transport as typeof fetch,
        undefined,
      );
    const results = await Promise.all([
      client.request(base, path, search(), "searchHotelReservations"),
      client.request(base, path, search(), "searchHotelReservations"),
    ]);
    expect(await results[0].json()).toEqual(await results[1].json());
    expect(transport).toHaveBeenCalledTimes(1);
    await client.request(base, path, search(), "searchHotelReservations");
    expect(transport).toHaveBeenCalledTimes(1);
    authorize.mockResolvedValue(false);
    await expect(
      client.request(base, path, search(), "searchHotelReservations"),
    ).rejects.toMatchObject({ statusCode: 403 });
    const another = new OhipHttpClient(
      { ...route, property_id: "property-b" },
      { ...scope(), propertyId: "property-b", cacheTtlMs: 5000 },
      transport as typeof fetch,
      undefined,
    );
    await another.request(base, path, search(), "searchHotelReservations");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rechecks authorization immediately before dispatch and binds the gateway to its assigned connection", async () => {
    const authorize = vi
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      transport = vi.fn();
    const client = new OhipHttpClient(
      route,
      { ...scope(), authorize },
      transport as typeof fetch,
      undefined,
    );
    await expect(
      client.request(base, path, search(), "searchHotelReservations"),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(transport).not.toHaveBeenCalled();
    process.env.OHIP_ALLOWED_HOSTS =
      "gateway.example.oraclecloud.com,another.example.oraclecloud.com";
    const bound = new OhipHttpClient(
      route,
      scope(),
      transport as typeof fetch,
      undefined,
    );
    await expect(
      bound.request(
        "https://another.example.oraclecloud.com",
        path,
        search(),
        "searchHotelReservations",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(transport).not.toHaveBeenCalled();
  });
  it("anchors business operation IDs/methods and the unsafe GET flag to retained official Oracle specs", () => {
    for (const version of ["26.2", "26.3", "26.4"]) {
      const spec = JSON.parse(
        readFileSync(
          new URL(`../fixtures/oracle-rsv-${version}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(
        spec.paths["/hotels/{hotelId}/reservations/searches"].post.operationId,
      ).toBe("searchHotelReservations");
      const get =
        spec.paths["/hotels/{hotelId}/reservations/{reservationId}"].get;
      expect(get.operationId).toBe("getReservation");
      expect(
        get.parameters.find((p: any) => p.name === "markAsRecentlyAccessed")
          .description,
      ).toMatch(/Marks the reservation/);
    }
    expect(Object.keys(APPROVED_OHIP_OPERATIONS).sort()).toEqual([
      "getReservation",
      "oauth_token",
      "searchHotelReservations",
    ]);
  });
});
