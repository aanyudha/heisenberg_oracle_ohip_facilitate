import { describe, it, expect, vi, beforeEach } from "vitest";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import {
  RealOhipAdapter,
  mapReservations,
  validateGateway,
  OhipError,
} from "../apps/api/src/ohip";
import { encrypt, decrypt } from "../apps/api/src/security";
import fixture from "../fixtures/reservations.json";
beforeEach(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
  process.env.OHIP_ALLOWED_HOSTS = "gateway.example.oraclecloud.com";
});
const connection = () => ({
  gateway: "https://gateway.example.oraclecloud.com",
  hotel_id: "HOTEL1",
  enterprise_id: "ENTERPRISE",
  encrypted_secret: encrypt({
    clientId: "test-client",
    clientSecret: "test-secret",
    applicationKey: "test-key",
  }),
});
describe("official Oracle contracts", () => {
  for (const version of ["26.2", "26.3", "26.4"])
    it(`validates request and fixture against Oracle release tag ${version}`, () => {
      const spec = JSON.parse(
        readFileSync(
          new URL(`../fixtures/oracle-rsv-${version}.json`, import.meta.url),
          "utf8",
        ),
      );
      const operation =
        spec.paths["/hotels/{hotelId}/reservations/searches"].post;
      expect(operation.operationId).toBe("searchHotelReservations");
      const ajv = new Ajv({ strict: false, validateFormats: false });
      ajv.addSchema({ $id: "oracle", definitions: spec.definitions });
      const request = ajv.compile({
          $ref: "oracle#/definitions/searchHotelReservationsRequest",
        }),
        response = ajv.compile({
          $ref: "oracle#/definitions/reservationsDetails",
        });
      expect(
        request({
          searchType: "Arrival",
          limit: 100,
          offset: 0,
          arrivalStartDate: "2026-10-27",
          arrivalEndDate: "2026-10-27",
        }),
        JSON.stringify(request.errors),
      ).toBe(true);
      expect(response(fixture), JSON.stringify(response.errors)).toBe(true);
      expect(mapReservations(fixture)[0]).toMatchObject({
        id: "98765",
        guest_name: "Sample Guest",
        room: "201",
        vip: true,
      });
    });
  it("rejects malformed mapping instead of inventing fields", () => {
    expect(() =>
      mapReservations({
        reservations: { reservationInfo: [{ id: "unknown" }] },
      }),
    ).toThrow();
  });
});
describe("OCIM lifecycle and read-only transport", () => {
  it("reconciles cached IDs outside today’s windows using the official request fields", async () => {
    const bodies: any[] = [];
    const t = vi.fn(async (url: any, options: any) => {
      if (String(url).endsWith("/tokens"))
        return Response.json({ access_token: "token", expires_in: 3600 });
      bodies.push(JSON.parse(options.body));
      return Response.json(fixture);
    }) as unknown as typeof fetch;
    await new RealOhipAdapter(connection(), t).read("2026-10-27", ["98765"]);
    expect(bodies.at(-1)).toMatchObject({
      searchType: "Any",
      reservationIdList: ["98765"],
    });
  });
  it("caches OAuth, uses POST search, and records matching sanitized correlation IDs", async () => {
    const events: any[] = [];
    const requests: { url: string; options: RequestInit }[] = [];
    const transport = vi.fn(async (url: any, options: any) => {
      requests.push({ url: String(url), options });
      return String(url).endsWith("/tokens")
        ? Response.json({ access_token: "test-token", expires_in: 3600 })
        : Response.json(fixture);
    }) as unknown as typeof fetch;
    const a = new RealOhipAdapter(connection(), transport, async (e) => {
      events.push(e);
    });
    await a.read("2026-10-27");
    await a.read("2026-10-27");
    expect(requests.filter((r) => r.url.endsWith("/tokens"))).toHaveLength(1);
    expect(requests).toHaveLength(7);
    expect(requests.every((r) => r.options.method === "POST")).toBe(true);
    const search = requests[1];
    expect(search.url).toBe(
      "https://gateway.example.oraclecloud.com/rsv/v1/hotels/HOTEL1/reservations/searches",
    );
    expect(JSON.parse(search.options.body as string)).toMatchObject({
      searchType: "Arrival",
      limit: 100,
      offset: 0,
    });
    expect((search.options.headers as any)["x-app-key"]).toBe("test-key");
    expect(events[1].correlationId).toBe(
      (search.options.headers as any)["x-request-id"],
    );
    expect(JSON.stringify(events)).not.toMatch(
      /test-secret|test-token|test-key|Sample/,
    );
  });
  it("refreshes once after a 401 without GET fallback", async () => {
    let token = 0,
      search = 0;
    const t = vi.fn(async (url: any) =>
      String(url).endsWith("/tokens")
        ? Response.json({ access_token: "token-" + ++token, expires_in: 3600 })
        : ++search === 1
          ? new Response("", { status: 401 })
          : Response.json(fixture),
    ) as unknown as typeof fetch;
    await new RealOhipAdapter(connection(), t).read("2026-10-27");
    expect(token).toBe(2);
    expect(search).toBe(4);
  });
  it("stops after a second 401", async () => {
    const t = vi.fn(async (url: any) =>
      String(url).endsWith("/tokens")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : new Response("", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      new RealOhipAdapter(connection(), t).read("2026-10-27"),
    ).rejects.toMatchObject({ status: 401, classification: "authentication" });
    expect(t).toHaveBeenCalledTimes(4);
  });
  it("honors Retry-After for throttling and classifies network failures", async () => {
    const t = vi.fn(async (url: any) =>
      String(url).endsWith("/tokens")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : new Response("", { status: 429, headers: { "retry-after": "60" } }),
    ) as unknown as typeof fetch;
    await expect(
      new RealOhipAdapter(connection(), t).read("2026-10-27"),
    ).rejects.toMatchObject({ status: 429, retryAfter: 60000 });
    await expect(
      new RealOhipAdapter(
        connection(),
        vi.fn(
          async () =>
            new Response("", { status: 429, headers: { "retry-after": "60" } }),
        ),
      ).read("2026-10-27"),
    ).rejects.toMatchObject({ status: 429, retryAfter: 60000 });
    await expect(
      new RealOhipAdapter(
        connection(),
        vi.fn().mockRejectedValue(new Error("TLS error")),
      ).read("2026-10-27"),
    ).rejects.toBeInstanceOf(OhipError);
  });
  it("rejects redirects and allows only explicit HTTPS gateway origins", () => {
    for (const url of [
      "http://gateway.example.oraclecloud.com",
      "https://gateway.example.oraclecloud.com@evil.test",
      "https://127.0.0.1",
      "https://gateway.example.oraclecloud.com/path",
    ])
      expect(() => validateGateway(url)).toThrow();
    expect(validateGateway("https://gateway.example.oraclecloud.com")).toBe(
      "https://gateway.example.oraclecloud.com",
    );
  });
  it("encrypts with authenticated encryption and fails on tampering", () => {
    const a = encrypt({ secret: "credential" }),
      b = encrypt({ secret: "credential" });
    expect(a).not.toBe(b);
    expect(a).not.toContain("credential");
    expect(decrypt(a)).toEqual({ secret: "credential" });
    const bytes = Buffer.from(a, "base64");
    bytes[30] ^= 1;
    expect(() => decrypt(bytes.toString("base64"))).toThrow();
  });
  it("supports empty 204 responses", async () => {
    const t = vi.fn(async (url: any) =>
      String(url).endsWith("/tokens")
        ? Response.json({ access_token: "token", expires_in: 3600 })
        : new Response(null, { status: 204 }),
    ) as unknown as typeof fetch;
    expect(
      (await new RealOhipAdapter(connection(), t).read("2026-10-27")).items,
    ).toEqual([]);
  });
});
