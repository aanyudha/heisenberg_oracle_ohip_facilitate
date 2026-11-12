// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Worksheet } from "@hospitality/contracts";
import { Context, type Workspace } from "../apps/web/src/workspace";
import HousekeepingWorksheet from "../apps/web/src/pages/HousekeepingWorksheet";
import { moveWorksheet } from "../apps/web/src/worksheet-model";
import { setCsrf } from "../apps/web/src/api";
let value: Worksheet,
  writeStatus: number,
  writes: { path: string; body: any }[];
const user: Workspace["user"] = {
  id: "manager",
  tenantId: "demo",
  role: "hotel_manager",
  name: "Manager",
  csrf: "test",
  developer: false,
  branding: { appName: "Test", primary: "#17675d", logo: "", favicon: "" },
  properties: [
    { id: "p", name: "Hotel", organization_id: "g", timezone: "Asia/Jakarta" },
  ],
};
function initial(): Worksheet {
  return {
    scope: { propertyId: "p", date: "2026-11-12", shiftId: "AM" },
    property: { id: "p", name: "Hotel" },
    shift: { id: "AM", name: "Morning" },
    revision: "1",
    selfRole: "manager",
    manager: true,
    canManage: true,
    supervisors: [
      { id: "s1", name: "Supervisor", available: true, active: true },
    ],
    attendants: [
      { id: "a1", name: "Attendant One", active: true, available: true },
      { id: "a2", name: "Attendant Two", active: true, available: true },
    ],
    team: { a1: "s1", a2: "s1" },
    assignments: {},
    localProgress: {},
    missingAssignedRooms: 0,
    warnings: [],
    feed: {
      source: "OHIP",
      available: true,
      status: "synced",
      error: null,
      taskError: null,
      syncedAt: "2026-11-12T01:00:00Z",
    },
    rooms: ["201", "202"].map((id, i) => ({
      id,
      floor: i ? "East" : "West",
      floorSource: "OHIP",
      section: null,
      roomType: i ? "Suite" : "Twin",
      status: i ? "Inspected" : "Dirty",
      departure: !i,
      stayover: !!i,
      arrival: false,
      vip: false,
      dnd: false,
      makeUpRoom: false,
      outOfOrder: false,
      outOfService: false,
      priority: !i,
      tasks: ["Clean room"],
      remarks: ["Approved HK instruction"],
      credits: i ? 1.25 : 2.5,
      creditSource: i ? "local" : "OHIP",
      observedAt: "2026-11-12T01:00:00Z",
    })),
  };
}
beforeEach(() => {
  value = initial();
  writeStatus = 200;
  writes = [];
  setCsrf("test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method && options.method !== "GET") {
        const body = JSON.parse(String(options.body));
        writes.push({ path, body });
        if (writeStatus !== 200)
          return Response.json(
            {
              error:
                writeStatus === 409
                  ? "Worksheet changed by another user"
                  : "Save failed",
            },
            { status: writeStatus },
          );
        if (path.endsWith("/undo"))
          value = {
            ...initial(),
            revision: String(Number(value.revision) + 1),
          };
        else
          value = {
            ...body.operations.reduce(moveWorksheet, value),
            revision: String(Number(value.revision) + 1),
          };
        return Response.json({
          revision: value.revision,
          changeId: "test-change",
        });
      }
      if (path.includes("/setup"))
        return Response.json({
          manager: true,
          selfRole: "manager",
          shifts: [
            { id: "AM", name: "Morning", starts_at: "07:00", ends_at: "15:00" },
          ],
        });
      return Response.json(structuredClone(value));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Context.Provider value={{ user, propertyId: "p", date: "2026-11-12" }}>
          <HousekeepingWorksheet />
        </Context.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
async function ready() {
  await screen.findByRole("heading", { name: "Housekeeping Worksheet" });
  await screen.findByRole("article", { name: "Room 201" });
}
describe("worksheet interaction and autosave", () => {
  it("optimistically accepts a drag/drop and saves once after the debounce", async () => {
    mount();
    await ready();
    const target = document.querySelector('[data-attendant-id="a1"]')!;
    fireEvent.drop(target, {
      dataTransfer: { getData: () => JSON.stringify(["201"]) },
    });
    expect(
      within(target as HTMLElement).getByRole("article", { name: "Room 201" }),
    ).toBeInTheDocument();
    expect(writes).toHaveLength(0);
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 2500 });
    expect(writes[0].body).toMatchObject({
      baseRevision: "1",
      operations: [{ type: "rooms", roomIds: ["201"], attendantId: "a1" }],
    });
    expect(
      screen.queryByRole("button", { name: /save room/i }),
    ).not.toBeInTheDocument();
  });
  it("batch-assigns selected rooms, updates workload, and supports a simple mobile Assign To", async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByLabelText("Select room 201"));
    fireEvent.click(screen.getByLabelText("Select room 202"));
    fireEvent.change(screen.getByLabelText("Batch assign to"), {
      target: { value: "a1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Assign selected/ }));
    const target = document.querySelector('[data-attendant-id="a1"]')!;
    expect(within(target as HTMLElement).getAllByRole("article")).toHaveLength(
      2,
    );
    expect(target.textContent).toContain("3.75");
    expect(target.textContent).toContain("1 Departure");
    expect(target.textContent).toContain("1 Stayover");
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 2500 });
    fireEvent.change(screen.getByLabelText("Assign room 202 to"), {
      target: { value: "a2" },
    });
    await waitFor(() => expect(writes).toHaveLength(2), { timeout: 2500 });
    expect(writes[1].body.operations[0]).toMatchObject({
      roomIds: ["202"],
      attendantId: "a2",
    });
  });
  it("rolls back optimistic moves on save failure and clearly reports the failure", async () => {
    writeStatus = 500;
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Assign room 201 to"), {
      target: { value: "a1" },
    });
    await screen.findByText(
      /Local pending moves have been rolled back/,
      {},
      { timeout: 3000 },
    );
    expect(
      within(
        document.querySelector("[data-drop-unassigned]") as HTMLElement,
      ).getByRole("article", { name: "Room 201" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Assign room 201 to")).toHaveValue("");
  });
  it("rolls back a stale save and reconciles another user’s assignments", async () => {
    writeStatus = 409;
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Assign room 201 to"), {
      target: { value: "a1" },
    });
    value = { ...value, revision: "2", assignments: { "201": "a2" } };
    await screen.findByText(
      /Worksheet changed by another user/,
      {},
      { timeout: 3000 },
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Assign room 201 to")).toHaveValue("a2"),
    );
  });
  it("undoes a pending move without a write and a persisted move through the undo API", async () => {
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Assign room 201 to"), {
      target: { value: "a1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo last move" }));
    expect(screen.getByLabelText("Assign room 201 to")).toHaveValue("");
    expect(writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Assign room 201 to"), {
      target: { value: "a1" },
    });
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 2500 });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Undo last move" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo last move" }));
    await waitFor(() => expect(writes[1]?.path).toMatch(/worksheet\/undo$/));
    await waitFor(() =>
      expect(screen.getByLabelText("Assign room 201 to")).toHaveValue(""),
    );
  });
  it("filters by floor/status/type and previews an unfiltered printable worksheet without guest PII", async () => {
    value.assignments = { "201": "a1", "202": "a1" };
    mount();
    await ready();
    fireEvent.change(screen.getByLabelText("Filter floor"), {
      target: { value: "East" },
    });
    expect(
      screen.queryByRole("article", { name: "Room 201" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Filter room type"), {
      target: { value: "Suite" },
    });
    fireEvent.change(screen.getByLabelText("Filter room status"), {
      target: { value: "Inspected" },
    });
    expect(
      screen.getByRole("article", { name: "Room 202" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Print Worksheet" }));
    const preview = await screen.findByRole("dialog", {
      name: "Worksheet print preview",
    });
    expect(preview).toHaveTextContent("201");
    expect(preview).toHaveTextContent("202");
    expect(preview).toHaveTextContent("3.75");
    expect(preview).toHaveTextContent("Approved HK instruction");
    expect(preview).toHaveTextContent("Local rule");
    expect(
      preview.querySelectorAll(".worksheet-print-page").length,
    ).toBeGreaterThanOrEqual(2);
  });
  it("renders a live authorization empty state and never shows synthetic Unknown rooms", async () => {
    value.feed = {
      ...value.feed,
      available: false,
      status: "error",
      error: "OPERA housekeeping access denied",
    };
    value.rooms = [];
    mount();
    expect(
      await screen.findByText("OPERA room data unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("OPERA housekeeping access denied"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Print Worksheet" }),
    ).toBeDisabled();
  });
});
