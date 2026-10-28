// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Context, type Workspace } from "../apps/web/src/workspace";
import Operations, { ReservationTable } from "../apps/web/src/pages/Operations";
import { Shell } from "../apps/web/src/main";
import { useRealtime } from "../apps/web/src/realtime";
import { State } from "../apps/web/src/components";
const user: Workspace["user"] = {
  id: "demo-admin",
  tenantId: "demo",
  name: "Admin",
  role: "group_admin",
  csrf: "csrf",
  developer: false,
  properties: [
    {
      id: "demo-1",
      name: "Demo Hotel",
      organization_id: "group",
      timezone: "Asia/Jakarta",
    },
  ],
  branding: {
    appName: "Sample Operations",
    primary: "#17675d",
    logo: "",
    favicon: "/favicon.svg",
  },
};
let sockets: FakeSocket[] = [];
class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    sockets.push(this);
  }
  close() {
    this.onclose?.({ code: 1000 });
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}
function wrap(
  child: React.ReactNode,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Context.Provider
            value={{ user, propertyId: "demo-1", date: "2026-10-27" }}
          >
            {child}
          </Context.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}
beforeEach(() => {
  sockets = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: [], total: 0 })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("SPA and data states", () => {
  it("navigates using the persistent shell without a document request", async () => {
    wrap(<Shell user={user} />);
    const header = screen.getByRole("banner");
    fireEvent.click(screen.getByRole("link", { name: "Reservations" }));
    expect(
      await screen.findByRole("heading", { name: "Reservations" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBe(header);
    expect(screen.getByRole("link", { name: "Reservations" })).toHaveClass(
      "active",
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every((c) => String(c[0]).startsWith("/api/")),
    ).toBe(true);
  });
  it("shows an empty reservation state", () => {
    wrap(<ReservationTable items={[]} onSelect={() => {}} />);
    expect(
      screen.getByText("No reservations match your filters."),
    ).toBeInTheDocument();
  });
  it("shows loading and recoverable errors", () => {
    const client = new QueryClient();
    function Loading() {
      const q = { isPending: true, isError: false } as any;
      return <State query={q}>Loaded</State>;
    }
    const r = wrap(<Loading />, client);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    r.unmount();
    wrap(
      <State
        query={
          {
            isPending: false,
            isError: true,
            error: Error("Service unavailable"),
            refetch: vi.fn(),
          } as any
        }
      >
        Loaded
      </State>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Service unavailable");
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });
  it("hides guest and admin menus from housekeeping", () => {
    wrap(<Shell user={{ ...user, role: "housekeeping" }} />);
    expect(
      screen.queryByRole("link", { name: "Reservations" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Branding" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Rooms & Housekeeping" }),
    ).toBeInTheDocument();
  });
  it("renders no-property workspaces without API requests for records", () => {
    wrap(<Shell user={{ ...user, properties: [] }} />);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });
  it("loads real task updates through query invalidation", async () => {
    let title = "Before change";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json({
          items: url.includes("/tasks")
            ? [
                {
                  id: "t",
                  title,
                  priority: "normal",
                  status: "open",
                  assignee: null,
                  updated_at: "2026-10-27T00:00:00Z",
                },
              ]
            : [],
        }),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { Routes, Route } = await import("react-router-dom");
    wrap(
      <Routes>
        <Route path="*" element={<Operations />} />
      </Routes>,
      client,
    ); // Explicit route below exercises the task view.
    cleanup();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/operations/tasks"]}>
          <Context.Provider
            value={{ user, propertyId: "demo-1", date: "2026-10-27" }}
          >
            <Routes>
              <Route path="/operations/:section" element={<Operations />} />
            </Routes>
          </Context.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Before change")).toBeInTheDocument();
    title = "After change";
    await client.invalidateQueries({ queryKey: ["tasks", "demo-1"] });
    expect(await screen.findByText("After change")).toBeInTheDocument();
  });
});
describe("realtime browser protocol", () => {
  function Harness() {
    const realtime = useRealtime(user);
    return <span>{realtime.state}</span>;
  }
  it("targets invalidation, records sequence for reconnect, and reconciles on tab activation", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["tasks", "demo-1"], { items: [] });
    client.setQueryData(["tasks", "other-1"], { items: [] });
    const invalidated = vi.spyOn(client, "invalidateQueries");
    wrap(<Harness />, client);
    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    await waitFor(() =>
      expect(screen.getByText("Connected")).toBeInTheDocument(),
    );
    invalidated.mockClear();
    sockets[0].message({ seq: 42, propertyId: "demo-1", topic: "tasks" });
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
    const predicate = (invalidated.mock.calls[0][0] as any).predicate;
    expect(predicate({ queryKey: ["tasks", "demo-1"] })).toBe(true);
    expect(predicate({ queryKey: ["tasks", "other-1"] })).toBe(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invalidated.mock.calls.length).toBeGreaterThan(1);
    sockets[0].close();
    await waitFor(() =>
      expect(screen.getByText("Reconnecting")).toBeInTheDocument(),
    );
    await waitFor(() => expect(sockets.length).toBe(2), { timeout: 2500 });
    expect(sockets[1].url).toContain("after=42");
  });
});

describe("strict monitoring-only operational UI", () => {
  it("always displays the OHIP read-only indicator", () => {
    wrap(<Shell user={user} />);
    expect(
      screen.getByText("OHIP READ ONLY", { exact: true }),
    ).toBeInTheDocument();
  });
  it.each(["tasks", "rooms"])(
    "removes operational write controls from %s",
    async (section) => {
      const { Routes, Route } = await import("react-router-dom");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({
            items:
              section === "tasks"
                ? [
                    {
                      id: "task",
                      title: "Historical task",
                      priority: "normal",
                      status: "open",
                      assignee: null,
                    },
                  ]
                : [
                    {
                      id: "101",
                      status: "dirty",
                      attention: "Inspection pending",
                    },
                  ],
            total: 1,
          }),
        ),
      );
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <MemoryRouter initialEntries={[`/operations/${section}`]}>
            <Context.Provider
              value={{ user, propertyId: "demo-1", date: "2026-10-28" }}
            >
              <Routes>
                <Route path="/operations/:section" element={<Operations />} />
              </Routes>
            </Context.Provider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await screen.findByText(
        section === "tasks" ? "Historical task" : "Inspection pending",
      );
      for (const name of [
        "Add task",
        "Mark inspected",
        "Mark dirty",
        "Create a related task",
      ])
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Task title")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Assign to")).not.toBeInTheDocument();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every((c) => !c[1]?.method || c[1].method === "GET"),
      ).toBe(true);
    },
  );
});
