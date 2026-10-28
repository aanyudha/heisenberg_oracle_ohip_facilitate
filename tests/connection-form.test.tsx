// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi, describe } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ConnectionCenter from "../apps/web/src/pages/ConnectionCenter";
let items: any[] = [];
const writes: { url: string; body: any }[] = [];
function renderCenter() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ConnectionCenter propertyId="property-a" />
    </QueryClientProvider>,
  );
}
const expected = [
  "appKey",
  "baseUrl",
  "clientId",
  "clientSecret",
  "enterpriseId",
  "hotelId",
];
beforeEach(() => {
  items = [];
  writes.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, options: any) => {
      if (options?.method && options.method !== "GET") {
        writes.push({ url: String(url), body: JSON.parse(options.body) });
        return Response.json({ ok: true, id: "connection-a" });
      }
      return Response.json({ items, total: items.length });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function shared() {
  return {
    id: "connection-a",
    base_url: "https://gateway.example.oraclecloud.com",
    client_id: "client-a",
    enterprise_id: "ENTERPRISE",
    status: "connected",
    health: "connected",
    last_connected: "2026-10-27T00:00:00Z",
    can_edit: true,
    assigned_properties: [
      {
        property_id: "property-a",
        name: "Hotel A",
        hotel_id: "HOTEL_A",
        is_primary: true,
        validation_status: "validated",
        last_validated_at: "2026-10-27T00:00:00Z",
        status: "connected",
      },
      {
        property_id: "property-b",
        name: "Hotel B",
        hotel_id: "HOTEL_B",
        is_primary: false,
        validation_status: "validated",
        status: "connected",
      },
    ],
  };
}
describe("six-field OCIM connection form", () => {
  it("creates with exactly six inputs and no mode/environment/chain/scope field; clears secrets after saving", async () => {
    renderCenter();
    await screen.findByText(
      "No accessible OHIP connections yet. Create a connection for the selected property.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create New Connection" }),
    );
    const form = screen.getByRole("form", { name: "Create Connection" });
    expect(
      [...form.querySelectorAll("input")].map((i) => i.name).sort(),
    ).toEqual(expected);
    const values = {
      baseUrl: "https://gateway.example.oraclecloud.com",
      clientId: "client-a",
      clientSecret: "private-secret",
      appKey: "private-key",
      enterpriseId: "ENTERPRISE",
      hotelId: "HOTEL_A",
    };
    for (const [name, value] of Object.entries(values))
      fireEvent.change(form.querySelector(`[name=${name}]`)!, {
        target: { value },
      });
    fireEvent.submit(form);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      url: "/api/ohip-connections",
      body: { propertyId: "property-a", ...values },
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "Create Connection" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByDisplayValue("private-secret"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/chain mapping/i)).not.toBeInTheDocument();
  });
  it("shows assigned properties/health and reuses credentials with only connection choice and Hotel ID", async () => {
    items = [shared()];
    renderCenter();
    await screen.findByText("Hotel B");
    expect(
      screen.getByRole("columnheader", { name: "Connection Health" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Last Connected" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Use Existing Connection" }),
    );
    const form = screen.getByRole("form", {
      name: "Assign Existing Connection",
    });
    expect(
      [...form.querySelectorAll("input,select")].map((i: any) => i.name).sort(),
    ).toEqual(["connectionId", "hotelId"]);
    fireEvent.change(form.querySelector('[name="hotelId"]')!, {
      target: { value: "HOTEL_NEW" },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(writes[0]).toEqual({
        url: "/api/ohip-connections/connection-a/assign",
        body: { propertyId: "property-a", hotelId: "HOTEL_NEW" },
      }),
    );
  });
  it("edits six parameters while leaving saved secrets blank and optional; supports a dedicated connection", async () => {
    items = [shared()];
    renderCenter();
    await screen.findByText("Hotel A");
    fireEvent.click(screen.getByRole("button", { name: "Edit Connection" }));
    const form = screen.getByRole("form", { name: "Edit Connection" });
    expect(
      [...form.querySelectorAll("input")].map((i) => i.name).sort(),
    ).toEqual(expected);
    for (const name of ["clientSecret", "appKey"]) {
      const input = form.querySelector(`[name=${name}]`) as HTMLInputElement;
      expect(input.value).toBe("");
      expect(input.required).toBe(false);
      expect(input.type).toBe("password");
    }
    fireEvent.submit(form);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.clientSecret).toBe("");
    expect(writes[0].body.appKey).toBe("");
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "Edit Connection" }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create Dedicated Connection" }),
    );
    expect(
      screen
        .getByRole("form", { name: "Create Connection" })
        .querySelectorAll("input"),
    ).toHaveLength(6);
  });
});
