import { describe, it, expect, vi, afterEach } from "vitest";
import { RealOhipAdapter, OCIM_SCOPE } from "../apps/api/src/ohip";
import { encrypt } from "../apps/api/src/security";
const gateway = "https://gateway.example.oraclecloud.com";
function connection(
  tenant = "tenant-a",
  id = "connection-a",
  hotel = "HOTEL_A",
) {
  return {
    tenant_id: tenant,
    connection_id: id,
    base_url: gateway,
    client_id: "client",
    encrypted_client_secret: encrypt("client-secret"),
    encrypted_app_key: encrypt("app-key"),
    enterprise_id: "ENTERPRISE",
    hotel_id: hotel,
  };
}
afterEach(() => vi.useRealTimers());
describe("shared OCIM token cache", () => {
  it("shares tokens across Hotel IDs, serializes concurrent refresh, expires early, and isolates tenants/credential revisions", async () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.OHIP_ALLOWED_HOSTS = "gateway.example.oraclecloud.com";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
    let tokens = 0;
    const requests: any[] = [];
    const transport = vi.fn(async (url: any, options: any) => {
      requests.push({ url: String(url), options });
      return String(url).endsWith("/tokens")
        ? Response.json({ access_token: "token-" + ++tokens, expires_in: 3600 })
        : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const first = connection(),
      a = new RealOhipAdapter(first, transport),
      b = new RealOhipAdapter({ ...first, hotel_id: "HOTEL_B" }, transport);
    await Promise.all([a.testConnection(), b.testConnection()]);
    expect(tokens).toBe(1);
    const headers = requests
      .filter((r) => !r.url.endsWith("/tokens"))
      .map((r) => r.options.headers);
    expect(headers.map((h) => h["x-hotelid"]).sort()).toEqual([
      "HOTEL_A",
      "HOTEL_B",
    ]);
    expect(headers.every((h) => h.Authorization === "Bearer token-1")).toBe(
      true,
    );
    expect(new URLSearchParams(requests[0].options.body).get("scope")).toBe(
      OCIM_SCOPE,
    );
    vi.setSystemTime(new Date("2026-10-27T00:59:01Z"));
    await Promise.all([a.testConnection(), b.testConnection()]);
    expect(tokens).toBe(2);
    await new RealOhipAdapter(
      { ...first, tenant_id: "tenant-b" },
      transport,
    ).testConnection();
    expect(tokens).toBe(3);
    await new RealOhipAdapter(
      { ...first, encrypted_client_secret: encrypt("rotated-secret") },
      transport,
    ).testConnection();
    expect(tokens).toBe(4);
  });
  it("refreshes a shared token once after rejection and never sends a refresh_token grant", async () => {
    process.env.ENCRYPTION_KEY = "a".repeat(64);
    process.env.OHIP_ALLOWED_HOSTS = "gateway.example.oraclecloud.com";
    let tokens = 0,
      checks = 0;
    const grants: string[] = [];
    const transport = vi.fn(async (url: any, options: any) => {
      if (String(url).endsWith("/tokens")) {
        grants.push(String(options.body));
        return Response.json({
          access_token: "token-" + ++tokens,
          expires_in: 3600,
        });
      }
      return ++checks === 1
        ? new Response(null, { status: 401 })
        : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await new RealOhipAdapter(connection(), transport).testConnection();
    expect(tokens).toBe(2);
    expect(checks).toBe(2);
    expect(
      grants.every(
        (b) =>
          new URLSearchParams(b).get("grant_type") === "client_credentials" &&
          !b.includes("refresh_token"),
      ),
    ).toBe(true);
  });
});
