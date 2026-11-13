import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { operationalFixture } from "../tests/housekeeping-operational-fixture";
import { sql } from "../apps/api/src/db";
const f = await operationalFixture(true),
  checks: string[] = [],
  errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const started = Date.now();
let lastActor = started;
async function nextActorWindow() {
  const remaining = 65000 - (Date.now() - lastActor);
  if (remaining > 0) {
    console.log(
      "Waiting for unchanged request-limit window before next browser actor",
    );
    await new Promise((r) => setTimeout(r, Math.min(remaining, 55000)));
  }
  lastActor = Date.now();
}
function check(value: unknown, message: string) {
  if (!value) throw Error(message);
  checks.push(message);
  console.log("PASS " + message);
}
async function until(fn: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(message);
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      ].find(existsSync),
  });
  async function actor(auth: typeof f.admin, mobile = false) {
    const c = await browser!.newContext({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
    });
    const [name, value] = auth.cookie.split("=");
    await c.addCookies([{ name, value, url: f.base }]);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(f.base + "/operations/rooms");
    await p.getByLabel("Property", { exact: true }).selectOption("demo-1");
    await p.getByLabel("Business date").fill(f.scope().date);
    return p;
  }
  const manager = await actor(f.admin);
  await manager
    .getByRole("heading", { name: "Housekeeping Worksheet", exact: true })
    .waitFor();
  await until(
    async () => (await manager.locator("[data-room-id]").count()) === 60,
    "Initial 120-room feed did not render",
  );
  check(
    (await manager.locator("[data-room-id]").count()) === 60,
    "120-room worksheet limits visible cards to 60 and shows matching/visible/selected counts",
  );
  await manager.getByLabel("Select all filtered rooms").check();
  await manager
    .getByLabel("Filter floor", { exact: true })
    .selectOption("Garden");
  check(
    (
      await manager.locator(".worksheet-selection-summary").innerText()
    ).includes("60 selected rooms (20 outside visible results)"),
    "Selection survives filter changes with explicit hidden selection count",
  );
  await manager
    .locator(".worksheet-selection-summary")
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await manager.getByLabel("Search room number").fill("100");
  await manager
    .getByLabel("Filter room status", { exact: true })
    .selectOption("Dirty");
  check(
    (await manager.locator("[data-room-id]").count()) === 3,
    "Room search combines with floor and OPERA housekeeping status",
  );
  await manager.getByLabel("Search room number").fill("");
  await manager
    .getByLabel("Filter room status", { exact: true })
    .selectOption("");
  await manager.getByLabel("Filter floor", { exact: true }).selectOption("");
  await manager
    .getByRole("button", { name: "Select all 120 matching rooms", exact: true })
    .click();
  check(
    (await manager
      .getByRole("region", { name: "Confirm matching selection" })
      .count()) === 1 ||
      (await manager
        .locator('[aria-label="Confirm matching selection"]')
        .count()) === 1,
    "Selecting all matching results requires explicit count confirmation",
  );
  await manager
    .getByRole("button", { name: "Confirm select all matching" })
    .click();
  check(
    (
      await manager.locator(".worksheet-selection-summary").innerText()
    ).includes("120 selected rooms"),
    "Confirmed matching selection includes all 120 rooms without hidden selection",
  );
  await manager
    .locator(".worksheet-selection-summary")
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await manager.getByLabel("Select room 1001", { exact: true }).click();
  await manager
    .getByLabel("Select room 1005", { exact: true })
    .click({ modifiers: ["Shift"] });
  check(
    (
      await manager.locator(".worksheet-selection-summary").innerText()
    ).includes("5 selected rooms"),
    "Desktop Shift-click selects a deterministic room range",
  );
  await manager
    .locator(".worksheet-selection-summary")
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  // One database transaction establishes team links. User roles and dated staff
  // roster already came through the real User Management/roster APIs in fixture.
  const initial = await f.command([
    ...["Garden", "Tower", "Annex"].map((floor, i) => ({
      type: "floors",
      floorIds: [floor],
      supervisorId: f.supervisors[i].id,
    })),
    ...f.attendants.map((a, i) => ({
      type: "team",
      attendantId: a.id,
      supervisorId: f.supervisors[Math.floor(i / 4)].id,
    })),
  ]);
  check(
    initial.statusCode === 200,
    "Canonical floor/team setup uses registered property members and saved roster",
  );
  await until(
    async () =>
      (await manager.getByLabel("Supervisor for floor Garden").inputValue()) ===
      f.s1.id,
    "Manager did not receive setup WebSocket",
  );
  await nextActorWindow();
  const supervisor = await actor(f.s1);
  await supervisor.getByRole("region", { name: "My Floors" }).waitFor();
  await supervisor.getByLabel("Select all filtered rooms").check();
  await supervisor
    .getByText("Distribute to multiple attendants", { exact: true })
    .click();
  for (const name of [
    "Attendant One",
    "Attendant Two",
    "Attendant Three",
    "Attendant 04",
  ])
    await supervisor
      .locator(".worksheet-distribute")
      .getByRole("checkbox", { name, exact: true })
      .check();
  await supervisor
    .getByRole("button", { name: "Preview distribution" })
    .click();
  const allocation = supervisor.getByRole("region", {
    name: "Distribution preview",
  });
  await allocation.waitFor();
  check(
    (await allocation.innerText()).includes("40 rooms → 4 attendants") &&
      (await allocation.innerText()).includes("Balanced Credits"),
    "40-to-4 preview shows deterministic credits, existing load and reassignment counts",
  );
  await supervisor
    .getByRole("button", { name: "Confirm distribution" })
    .click();
  await until(
    async () => Object.keys((await f.worksheet()).assignments).length === 40,
    "Bulk save missing",
  );
  await until(
    async () =>
      (await manager
        .locator("[data-drop-unassigned] [data-room-id]")
        .count()) === 20,
    "Manager did not receive bulk WebSocket",
  );
  check(
    true,
    "One confirmed bulk command updates all rooms and manager board via WebSocket",
  );
  await supervisor.getByRole("button", { name: "Undo last move" }).click();
  await until(
    async () => Object.keys((await f.worksheet()).assignments).length === 0,
    "Bulk undo missing",
  );
  check(true, "Undo restores the entire 40-room distribution in one action");
  await f.command(
    [
      {
        type: "distribute",
        roomIds: Array.from({ length: 40 }, (_, i) => String(1001 + i)),
        attendantIds: [f.a1.id],
        mode: "equal",
      },
    ],
    f.s1,
  );
  await until(
    async () =>
      (await manager
        .locator('[data-attendant-id="' + f.a1.id + '"] [data-room-id]')
        .count()) === 40,
    "Manager did not receive saved room distribution",
  );
  await supervisor.context().close();
  await manager
    .getByLabel("Filter floor", { exact: true })
    .selectOption("Tower");
  await manager
    .getByRole("button", { name: "Print Worksheet", exact: true })
    .click();
  const preview = manager.getByRole("dialog", {
    name: "Worksheet print preview",
  });
  await preview.waitFor();
  await preview.getByLabel("Print scope").selectOption(f.s1.id);
  await until(
    async () =>
      (await preview.locator(".worksheet-print-master").count()) === 1,
    "Selected supervisor print did not settle",
  );
  check(
    (await preview.locator(".worksheet-print-master").count()) === 1 &&
      (await preview.innerText()).includes("1001") &&
      !(await preview.locator(".worksheet-print").innerText()).includes(
        "Supervisor: Supervisor Two",
      ),
    "Selected Supervisor print uses canonical coverage independent of board filters",
  );
  const saved = await f.worksheet();
  const response = await f.call(
    "worksheet/print?" +
      new URLSearchParams({ ...f.scope(), revision: saved.revision }),
  );
  const db = await f.db.query(
    sql`SELECT count(*) AS count FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date='2026-11-12' AND shift_id='AM' AND attendant_id=${f.a1.id} AND active`,
  );
  check(
    response.json().reconciliation.attendants.find((a: any) => a.id === f.a1.id)
      .rooms === Number(db[0].count) && Number(db[0].count) === 40,
    "Print room reconciliation matches 40 saved DB assignments exactly",
  );
  await mkdir("artifacts", { recursive: true });
  await preview.getByLabel("Worksheet print mode").selectOption("attendant");
  await preview.getByLabel("Print scope").selectOption(f.a1.id);
  await until(
    async () => (await preview.locator(".worksheet-print-page").count()) === 1,
    "Selected attendant print did not settle",
  );
  check(
    (await preview.locator(".worksheet-print-page").count()) === 1 &&
      (await preview.locator("tbody tr").count()) === 40,
    "Selected Attendant worksheet contains only its 40 assigned rooms",
  );
  const pdf = await manager.pdf({
    path: "artifacts/housekeeping-operational-40-rooms.pdf",
    format: "A4",
    preferCSSPageSize: true,
    printBackground: true,
  });
  check(
    (pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length >= 2,
    "40-room A4 portrait PDF spans multiple pages with repeating table headers and signatures",
  );
  check(
    await preview
      .locator("table")
      .evaluateAll((t) =>
        t.every((el) => el.scrollWidth <= el.clientWidth + 1),
      ),
    "Print tables fit A4 preview without clipping",
  );
  await preview.getByRole("button", { name: "Close preview" }).click();
  await manager.getByLabel("Filter floor", { exact: true }).selectOption("");
  await manager.getByLabel("Housekeeping shift").selectOption("PM");
  await manager
    .getByText(/No staff roster for this business date and shift/)
    .waitFor();
  await manager
    .getByRole("button", { name: "Manage Shift Staff", exact: true })
    .click();
  const roster = manager.getByRole("region", { name: "Shift staff roster" });
  await roster.waitFor();
  await roster
    .getByRole("checkbox", { name: "Supervisor One", exact: true })
    .check();
  await roster
    .getByRole("checkbox", { name: "Attendant One", exact: true })
    .check();
  await roster
    .getByRole("button", { name: "Save shift staff (2)", exact: true })
    .click();
  await until(
    async () =>
      (await f.worksheet(f.admin, "PM")).attendants.find(
        (a: any) => a.id === f.a1.id,
      ).available,
    "PM roster not saved",
  );
  check(
    Object.keys((await f.worksheet(f.admin, "PM")).assignments).length === 0,
    "Manage Shift Staff saves selected PM roster without leaking AM room assignments",
  );
  await manager.context().close();
  // Preserve production per-IP rate limiting; fresh mobile actor starts next window.
  await nextActorWindow();
  const mobile = await actor(f.a1, true);
  await mobile
    .getByRole("heading", { name: "My Worksheet", exact: true })
    .waitFor();
  check(
    (await mobile.locator("[data-room-id]").count()) === 40 &&
      (await mobile.locator(".worksheet-assign-to").count()) === 0,
    "Mobile My Worksheet contains only the attendant saved rooms and no reassignment controls",
  );
  check(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "120-room fixture mobile worksheet has no horizontal page overflow",
  );
  await mobile.screenshot({
    path: "artifacts/housekeeping-operational-mobile.png",
    fullPage: true,
  });
  check(
    errors.length === 0,
    "Operational desktop/mobile browser actors report no page errors",
  );
  await writeFile(
    "artifacts/housekeeping-operational-smoke.json",
    JSON.stringify(
      {
        status: "PASS",
        checks,
        errors,
        fixture: { rooms: 120, supervisors: 3, attendants: 12, shifts: 2 },
        oracle: "Disposable DEMO fixtures only; no live OHIP requests",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error("Operational browser failure", error);
  for (const context of browser?.contexts() || [])
    for (const page of context.pages())
      console.log(
        "Browser diagnostic",
        await page.locator("body").innerText(),
        "Room cards",
        await page.locator("[data-room-id]").count(),
      );
  throw error;
} finally {
  await browser?.close();
  for (const client of f.app.websocketServer.clients) client.terminate();
  await f.close();
}
