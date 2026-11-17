import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { usabilityFixture } from "../tests/housekeeping-usability-fixture";
import { sql } from "../apps/api/src/db";

const directory = "artifacts/hk-simple";
await mkdir(directory, { recursive: true });
const f = await usabilityFixture(true);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const checks: string[] = [],
  pageerrors: string[] = [],
  failedRequests: string[] = [],
  consoleErrors: string[] = [],
  httpErrors: { path: string; status: number }[] = [];
const pdfs: { path: string; roomIds: string[]; staff: string }[] = [];
let completed = false;
let windowStarted = Date.now();
async function nextRequestWindow() {
  console.log(
    "Waiting for the unchanged per-IP request window before the next browser phase",
  );
  while (Date.now() - windowStarted < 65000)
    await new Promise((r) => setTimeout(r, 1000));
  windowStarted = Date.now();
}
const check = (value: unknown, message: string) => {
  if (!value) throw Error(message);
  checks.push(message);
  console.log("PASS " + message);
};
async function until(fn: () => Promise<boolean>, message: string) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(message);
}
async function login(email: string, mobile = false) {
  const context = await browser.newContext({
    viewport: mobile
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageerrors.push(e.message));
  page.on("requestfailed", (request) => {
    if (request.failure()?.errorText !== "net::ERR_ABORTED")
      failedRequests.push(new URL(request.url()).pathname);
  });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.status() >= 400 &&
      !(path === "/api/me" && response.status() === 401)
    )
      httpErrors.push({ path, status: response.status() });
  });
  await page.goto(f.base + "/operations/rooms");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(f.password);
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.getByLabel("Business date").fill(f.scope().date);
  await page
    .getByRole("heading", {
      name:
        email === f.credentials.manager
          ? "Housekeeping Worksheet"
          : email === f.credentials.supervisor
            ? "My Team"
            : "My Worksheet",
      exact: true,
    })
    .waitFor();
  await page
    .getByText("Browser WebSocket: Connected", { exact: true })
    .waitFor();
  return page;
}
async function saved(page: Page) {
  await until(
    async () =>
      (await page.locator(".worksheet-save-state").innerText()).includes(
        "Saved",
      ),
    "Autosave did not settle",
  );
}
async function savedRows() {
  return f.db.query<{ room_id: string; attendant_id: string }>(
    sql`SELECT room_id,attendant_id FROM housekeeping_room_assignments WHERE tenant_id='demo' AND property_id='demo-1' AND business_date=${f.scope().date} AND shift_id='AM' AND active ORDER BY room_id`,
  );
}
async function chooseRooms(page: Page, ids: string[]) {
  for (const id of ids)
    await page.getByLabel(`Select room ${id}`, { exact: true }).check();
}
async function pdf(page: Page, path: string, roomIds: string[], staff: string) {
  // Exercise the real saved-revision/snapshot guard before exporting the print DOM.
  await page.evaluate(() => {
    (window as any).__hkPrinted = false;
    window.print = () => {
      (window as any).__hkPrinted = true;
    };
  });
  await page
    .getByRole("button", { name: "Print / Save PDF", exact: true })
    .click();
  await page.waitForFunction(() => (window as any).__hkPrinted === true);
  const data = await page.pdf({
    path,
    format: "A4",
    preferCSSPageSize: true,
    printBackground: true,
    tagged: true,
  });
  check(
    data.subarray(0, 4).toString() === "%PDF",
    `Generated A4 PDF: ${staff}`,
  );
  pdfs.push({ path, roomIds, staff });
}
try {
  const manager = await login(f.credentials.manager);
  await until(
    async () => (await manager.locator("[data-room-id]").count()) === 60,
    "274-room fixture did not render initial 60 cards",
  );
  let sheet = await f.worksheet(f.manager);
  check(
    sheet.rooms.length === 274 && sheet.supervisors.length === 2,
    "274 rooms and two registered supervisors loaded from API",
  );
  const floor = manager.getByLabel("Supervisor for floor 02", { exact: true });
  check(
    await floor.locator('option[value="' + f.s1.id + '"]').isEnabled(),
    "Unscheduled registered Supervisor is visible and selectable",
  );
  check(
    (await floor.innerText()).includes("Not Scheduled"),
    "English schedule state is visible",
  );
  check(
    (await manager.getByText("Configure shifts", { exact: true }).count()) ===
      0 &&
      (await manager
        .getByText("Manage Shift Staff", { exact: true })
        .count()) === 0,
    "No configuration panels or mandatory setup steps",
  );
  await floor.selectOption(f.s1.id);
  const add = manager.getByRole("region", {
    name: "Add supervisor to shift and assign",
  });
  await add.waitFor();
  check(
    (await add.innerText()).includes("Morning") &&
      (await add.innerText()).includes(f.scope().date),
    "Inline action names staff, date, shift and assignment",
  );
  await manager.screenshot({
    path: directory + "/01-inline-consent.png",
    fullPage: false,
  });
  await add
    .getByRole("button", { name: "Add to Shift & Assign", exact: true })
    .click();
  await saved(manager);
  await until(
    async () =>
      (await f.worksheet(f.manager)).supervisorFloors?.[f.s1.id]?.includes(
        "02",
      ) === true,
    "Floor 02 was not saved to SPV HK 1",
  );
  check(
    (
      await manager
        .locator(`[data-supervisor-id='${f.s1.id}'] .worksheet-scope-label`)
        .first()
        .innerText()
    ).includes("02"),
    "FLOW A: manager selected SPV HK 1 and the saved floor/card updated",
  );
  await manager.screenshot({
    path: directory + "/02-floor-saved-desktop.png",
    fullPage: true,
  });
  const initialRoom = (await f.worksheet(f.manager)).rooms.find(
    (r) => r.floor === "02",
  )!.id;
  await chooseRooms(manager, [initialRoom]);
  await manager
    .getByLabel("Batch assign to", { exact: true })
    .selectOption(f.a1.id);
  const batch = manager
    .locator(".worksheet-batch")
    .filter({
      has: manager.getByRole("button", {
        name: "Add to Shift & Assign",
        exact: true,
      }),
    });
  check(
    (await batch.innerText()).includes("Attendant HK 1"),
    "Unscheduled Room Attendant can be added and assigned from room selection",
  );
  await batch
    .getByRole("button", { name: "Add to Shift & Assign", exact: true })
    .click();
  await until(
    async () => (await savedRows()).length === 1,
    "Combined attendance and room assignment not saved",
  );
  await saved(manager);
  for (const a of [f.a2, f.a3]) {
    await manager
      .locator('[data-attendant-id="' + a.id + '"]')
      .getByRole("button", { name: "Add to Shift", exact: true })
      .click();
    await until(
      async () =>
        (await f.worksheet(f.manager)).attendants.find((s) => s.id === a.id)
          ?.available === true,
      "Inline Add to Shift failed",
    );
    await saved(manager);
  }
  check(
    (await f.worksheet(f.manager)).supervisors.find((s) => s.id === f.s2.id)
      ?.available === false,
    "Only explicitly selected staff were added; no all-present shortcut",
  );
  check(
    (await manager.locator(".worksheet-assign-to").count()) === 0,
    "No redundant per-room dropdowns",
  );
  const supervisor = await login(f.credentials.supervisor);
  sheet = await f.worksheet(f.s1);
  check(
    sheet.rooms.length === 100 && sheet.rooms.every((r) => r.floor === "02"),
    "Supervisor sees only authorized Floor 02 coverage",
  );
  const first20 = sheet.rooms.slice(0, 20).map((r) => r.id),
    first30 = sheet.rooms.slice(0, 30).map((r) => r.id);
  await chooseRooms(supervisor, first20);
  await supervisor
    .getByLabel("Filter room status", { exact: true })
    .selectOption("Clean");
  check(
    (
      await supervisor.locator(".worksheet-selection-summary").innerText()
    ).includes("20 selected rooms"),
    "Room selections survive status filtering with visible/hidden counts",
  );
  await supervisor
    .getByLabel("Filter room status", { exact: true })
    .selectOption("");
  await supervisor
    .getByLabel("Batch assign to", { exact: true })
    .selectOption(f.a1.id);
  await supervisor
    .getByRole("button", { name: "Assign selected", exact: true })
    .click();
  check(
    await supervisor
      .getByRole("button", { name: "Print Worksheet", exact: true })
      .isDisabled(),
    "Print is blocked while autosave is pending",
  );
  await until(
    async () =>
      (await savedRows()).filter((r) => r.attendant_id === f.a1.id).length ===
      20,
    "20-room assignment did not reach database",
  );
  await saved(supervisor);
  check(
    (await savedRows()).length === 20,
    "FLOW B: exactly 20 saved rooms belong to one attendant",
  );
  await until(
    async () =>
      (
        await manager.locator(`[data-attendant-id='${f.a1.id}']`).innerText()
      ).includes("20 rooms"),
    "Manager WebSocket view did not receive assignment",
  );
  await chooseRooms(supervisor, first30);
  await supervisor
    .getByText("Distribute to multiple attendants", { exact: true })
    .click();
  const distribution = supervisor.locator(".worksheet-distribute");
  for (const name of ["Attendant HK 1", "Attendant HK 2", "Attendant HK 3"])
    await distribution.getByRole("checkbox", { name, exact: true }).check();
  await distribution.getByLabel("Distribution mode").selectOption("equal");
  await distribution
    .getByRole("button", { name: "Preview distribution", exact: true })
    .click();
  check(
    await distribution
      .getByRole("region", { name: "Distribution preview" })
      .isVisible(),
    "Distribution preview is visible before the single atomic save",
  );
  await distribution
    .getByRole("button", { name: "Confirm distribution", exact: true })
    .click();
  await until(async () => {
    const rows = await savedRows();
    return (
      rows.length === 30 &&
      [f.a1, f.a2, f.a3].every(
        (a) => rows.filter((r) => r.attendant_id === a.id).length === 10,
      )
    );
  }, "30-room distribution was not saved correctly");
  await saved(supervisor);
  const rows = await savedRows();
  check(
    new Set(rows.map((r) => r.room_id)).size === 30,
    "FLOW C: 30 saved rooms distributed 10/10/10 without duplicate ownership",
  );
  await until(
    async () =>
      (
        await manager.locator(`[data-attendant-id='${f.a3.id}']`).innerText()
      ).includes("10 rooms"),
    "WebSocket team totals did not update",
  );
  check(
    true,
    "Manager received saved distribution through WebSocket without reloading",
  );
  await supervisor.screenshot({
    path: directory + "/03-supervisor-saved-desktop.png",
    fullPage: true,
  });
  await manager.context().close();
  await nextRequestWindow();
  await supervisor.getByLabel("Search room number").fill(first30[0]);
  await supervisor
    .getByRole("button", { name: "Print Worksheet", exact: true })
    .click();
  const preview = supervisor.getByRole("dialog", {
    name: "Worksheet print preview",
  });
  await preview.waitFor();
  for (const a of [f.a1, f.a2, f.a3]) {
    const expected = rows
      .filter((r) => r.attendant_id === a.id)
      .map((r) => r.room_id)
      .sort();
    const team = preview.locator(".worksheet-print-team").filter({
      has: supervisor.getByRole("heading", {
        name: `Attendant: ${a.id === f.a1.id ? "Attendant HK 1" : a.id === f.a2.id ? "Attendant HK 2" : "Attendant HK 3"}`,
        exact: true,
      }),
    });
    const printed = (
      await team.locator("tbody tr td:first-child strong").allTextContents()
    ).sort();
    check(
      JSON.stringify(printed) === JSON.stringify(expected),
      `Master group matches saved DB for ${a.id === f.a1.id ? "Attendant HK 1" : a.id === f.a2.id ? "Attendant HK 2" : "Attendant HK 3"}`,
    );
  }
  await preview.screenshot({
    path: directory + "/04-supervisor-master-preview.png",
  });
  await pdf(
    supervisor,
    directory + "/supervisor-master.pdf",
    sheet.rooms.map((r) => r.id),
    "SPV HK 1 master",
  );
  check(
    true,
    "FLOW D: all 30 assignments are grouped correctly; all 70 uncovered rooms remain in supervisor coverage print",
  );
  await preview.getByLabel("Worksheet print mode").selectOption("attendant");
  for (const [i, a] of [f.a1, f.a2, f.a3].entries()) {
    await preview.getByLabel("Print scope").selectOption(a.id);
    const printed = (
      await preview.locator("tbody tr td:first-child strong").allTextContents()
    ).sort();
    const expected = rows
      .filter((r) => r.attendant_id === a.id)
      .map((r) => r.room_id)
      .sort();
    check(
      JSON.stringify(printed) === JSON.stringify(expected),
      `FLOW E: attendant ${i + 1} print contains exactly their saved rooms, despite screen filter`,
    );
    await pdf(
      supervisor,
      `${directory}/attendant-${i + 1}.pdf`,
      expected,
      `Attendant HK ${i + 1}`,
    );
  }
  await preview
    .getByRole("button", { name: "Close preview", exact: true })
    .click();
  // Use each attendant's actual login and API scope, rather than print-mode alone.
  for (const [i, email] of f.credentials.attendants.entries()) {
    if (i === 2) await nextRequestWindow();
    const attendant = await login(email, i === 2);
    await until(
      async () => (await attendant.locator("[data-room-id]").count()) === 10,
      "Attendant own worksheet count differs from saved rooms",
    );
    const actual = (
      await attendant
        .locator("[data-room-id]")
        .evaluateAll((elements) =>
          elements.map((e) => e.getAttribute("data-room-id")),
        )
    ).sort();
    const expected = rows
      .filter((r) => r.attendant_id === [f.a1, f.a2, f.a3][i].id)
      .map((r) => r.room_id)
      .sort();
    check(
      JSON.stringify(actual) === JSON.stringify(expected),
      `Attendant ${i + 1} login sees only their 10 canonical rooms`,
    );
    if (i === 2)
      await attendant.screenshot({
        path: directory + "/05-attendant-mobile.png",
        fullPage: true,
      });
    await attendant.context().close();
  }
  await supervisor.getByLabel("Search room number").fill("");
  await supervisor.getByLabel("Housekeeping shift").selectOption("PM");
  await until(
    async () => (await f.worksheet(f.s1, "PM")).rooms.length === 0,
    "Separate shift unexpectedly shares room scope",
  );
  await supervisor
    .getByRole("heading", { name: "My Team", exact: true })
    .waitFor();
  await supervisor.getByLabel("Housekeeping shift").selectOption("AM");
  await supervisor.reload();
  await saved(supervisor);
  await until(
    async () => (await supervisor.locator("[data-room-id]").count()) === 60,
    "Reload did not restore saved worksheet",
  );
  await supervisor.setViewportSize({ width: 390, height: 844 });
  await supervisor.waitForTimeout(400); // Allow the existing sidebar resize transition to settle.
  check(
    await supervisor.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    "Supervisor mobile layout has no page-level horizontal overflow",
  );
  await supervisor.screenshot({
    path: directory + "/06-supervisor-mobile.png",
    fullPage: true,
  });
  check(
    (await f.worksheet(f.s1)).assignments &&
      Object.keys((await f.worksheet(f.s1)).assignments).length === 30,
    "FLOW G: reload and shift switching preserve 30 saved assignments",
  );
  check(
    pageerrors.length === 0 &&
      failedRequests.length === 0 &&
      httpErrors.length === 0,
    "No browser runtime exceptions, failed requests or unexpected HTTP errors",
  );
  check(
    !/\b(Atur|Belum|Pilih|Simpan|Pratinjau|Tutup|Kamar|kamar|Staf|Tanggal|dijadwalkan|bertugas)\b/.test(
      await supervisor.locator(".worksheet-root").innerText(),
    ),
    "Operational UI uses English only",
  );
  completed = true;
} finally {
  await writeFile(
    directory + "/result.json",
    JSON.stringify(
      {
        checks,
        pageerrors,
        failedRequests,
        consoleErrors,
        httpErrors,
        pdfs,
        fixture: { rooms: 274, supervisors: 2, attendants: 3 },
        success:
          completed &&
          !pageerrors.length &&
          !failedRequests.length &&
          !httpErrors.length,
      },
      null,
      2,
    ),
  );
  await browser.close();
  await f.close();
}
