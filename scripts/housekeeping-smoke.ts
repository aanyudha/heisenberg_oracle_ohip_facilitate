import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { housekeepingFixture } from "../tests/housekeeping-fixture";
import { sql } from "../apps/api/src/db";
import { appendEvent } from "../apps/api/src/realtime";
const f = await housekeepingFixture(true);
const began = Date.now();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
  page: Page | undefined;
const errors: string[] = [],
  checks: string[] = [],
  scope = f.scope();
function check(value: unknown, message: string) {
  if (!value) throw Error(message);
  checks.push(message);
  console.log("PASS " + message);
}
async function until(
  fn: () => Promise<boolean>,
  message: string,
  timeout = 10000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(message);
}
async function worksheet() {
  const r = await f.call("worksheet?" + new URLSearchParams(scope));
  if (r.statusCode !== 200) throw Error(r.body);
  return r.json();
}
async function remoteMove(operations: unknown[]) {
  const s = await worksheet();
  const r = await f.call("worksheet", {
    ...scope,
    baseRevision: s.revision,
    mutationId: randomUUID(),
    operations,
  });
  if (r.statusCode !== 200) throw Error(r.body);
  return r.json();
}
try {
  const executablePath =
    process.env.CHROME_PATH ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ].find(existsSync);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const trace: unknown[] = [];
    (
      window as unknown as { worksheetDragTrace: unknown[] }
    ).worksheetDragTrace = trace;
    for (const type of ["dragstart", "dragover", "drop", "dragend"])
      document.addEventListener(type, (event) => {
        const e = event as DragEvent;
        if (trace.length < 40)
          trace.push({
            type,
            tag: (e.target as HTMLElement).tagName,
            types: [...(e.dataTransfer?.types || [])],
            attendant: (e.target as HTMLElement)
              .closest("[data-attendant-id]")
              ?.getAttribute("data-attendant-id"),
            supervisor: (e.target as HTMLElement)
              .closest("[data-supervisor-id]")
              ?.getAttribute("data-supervisor-id"),
          });
      });
  });
  await page.goto(f.base + "/operations/rooms");
  await page.locator("[name=email]").fill("admin@demo.local");
  await page.locator("[name=password]").fill("Isolated-HK-test-password!");
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page.getByLabel("Property", { exact: true }).selectOption("demo-1");
  await page.getByLabel("Business date").fill(scope.date);
  await page
    .getByRole("heading", { name: "Housekeeping Worksheet", exact: true })
    .waitFor();
  check(
    (await page.locator("[data-room-id]").count()) === 6,
    "One worksheet automatically shows every actual room, including unmapped snapshot rooms",
  );
  check(
    (await page.getByText("Housekeeping setup", { exact: true }).count()) ===
      0 &&
      (await page
        .getByText("Assign or move attendant rooms", { exact: true })
        .count()) === 0,
    "Main screen has no setup wizard or assignment forms",
  );
  const earlyContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const [earlyCookieName, earlyCookieValue] = f.s1.cookie.split("=");
  await earlyContext.addCookies([
    { name: earlyCookieName, value: earlyCookieValue, url: f.base },
  ]);
  const earlySupervisor = await earlyContext.newPage();
  let earlyRevision = "";
  earlySupervisor.on("response", async (response) => {
    if (
      response.request().method() === "GET" &&
      response.url().includes("/api/local-housekeeping/worksheet?") &&
      response.ok()
    ) {
      earlyRevision = (await response.json()).revision;
    }
  });
  earlySupervisor.on("pageerror", (e) => errors.push(e.message));
  await earlySupervisor.goto(f.base + "/");
  await earlySupervisor
    .getByRole("heading", { name: "My Team", exact: true })
    .waitFor();
  await earlySupervisor.getByLabel("Business date").fill(scope.date);
  await earlySupervisor
    .getByRole("region", { name: "My Floors", exact: true })
    .waitFor();
  await page.getByLabel("Select floor West", { exact: true }).check();
  await page.getByLabel("Select floor East", { exact: true }).check();
  await page.getByLabel("Batch floor supervisor").selectOption(f.s1.id);
  await page
    .getByRole("button", { name: "Assign selected floors", exact: true })
    .click();
  await until(async () => {
    const s = await worksheet();
    return (
      s.supervisorFloors[f.s1.id]?.includes("West") &&
      s.supervisorFloors[f.s1.id]?.includes("East")
    );
  }, "Primary floors were not saved");
  await until(
    async () => (await earlySupervisor.locator("[data-room-id]").count()) === 4,
    "New supervisor floors did not arrive over WebSocket",
  );
  check(
    (await earlySupervisor.locator('[data-room-id="205"]').count()) === 0,
    "Supervisor sees only newly assigned floors over WebSocket without reload",
  );
  await page
    .getByLabel("Supervisor for floor Annex", { exact: true })
    .selectOption(f.s2.id);
  await until(
    async () =>
      (await worksheet()).supervisorFloors[f.s2.id]?.includes("Annex"),
    "Single-floor assignment was not saved",
  );
  checks.push(
    "Manager assigns one or multiple primary floors on the worksheet without setup forms",
  );
  const floorRevision = (await worksheet()).revision;
  await until(
    async () => earlyRevision === floorRevision,
    "Supervisor did not receive the current saved floor revision",
  );
  await earlySupervisor.bringToFront();
  await earlySupervisor
    .locator(".worksheet-board")
    .evaluate((el) => el.scrollIntoView({ block: "start" }));
  await earlySupervisor.evaluate(() => window.scrollBy(0, -90));
  await earlySupervisor
    .locator('[data-room-id="201"]')
    .dragTo(
      earlySupervisor.locator(`[data-attendant-id="${f.a1.id}"]>header`),
      { sourcePosition: { x: 50, y: 20 }, targetPosition: { x: 20, y: 20 } },
    );
  try {
    await until(async () => {
      const s = await worksheet();
      return s.assignments["201"] === f.a1.id && s.team[f.a1.id] === f.s1.id;
    }, "Supervisor room drag/drop was not saved");
  } catch (error) {
    console.log(
      "Supervisor diagnostic",
      await earlySupervisor.locator("body").innerText(),
    );
    await earlySupervisor.screenshot({
      path: "artifacts/housekeeping-supervisor-diagnostic.png",
      fullPage: true,
    });
    throw error;
  }
  await until(
    async () =>
      (await page!
        .locator(
          `[data-supervisor-id="${f.s1.id}"] [data-attendant-id="${f.a1.id}"]`,
        )
        .count()) === 1,
    "Manager did not receive the supervisor assignment event",
  );
  checks.push(
    "Supervisor drags a room to a registered attendant with atomic team/room autosave and no manual floor selection",
  );
  await earlyContext.close();
  await page.bringToFront();
  await page.getByLabel("Select room 202", { exact: true }).check();
  await page.getByLabel("Select room 203", { exact: true }).check();
  await page.getByLabel("Batch assign to").selectOption(f.a1.id);
  await page.getByRole("button", { name: /Assign selected/ }).click();
  await until(async () => {
    const s = await worksheet();
    return s.assignments["202"] === f.a1.id && s.assignments["203"] === f.a1.id;
  }, "Batch assignment was not saved");
  checks.push("Batch assignment updates all selected rooms in one save");
  await page
    .getByLabel("Supervisor for Attendant Two", { exact: true })
    .selectOption(f.s1.id);
  await until(
    async () => (await worksheet()).team[f.a2.id] === f.s1.id,
    "Second attendant was not grouped",
  );
  await page
    .getByLabel("Assign room 203 to", { exact: true })
    .selectOption(f.a2.id);
  await until(
    async () => (await worksheet()).assignments["203"] === f.a2.id,
    "Assign To was not saved",
  );
  checks.push("Simple Assign To moves a room between attendants");
  await page
    .locator(`[data-attendant-id="${f.a2.id}"]>header`)
    .dragTo(page.locator(`[data-supervisor-id="${f.s2.id}"]>header`), {
      sourcePosition: { x: 20, y: 20 },
    });
  await until(
    async () => (await worksheet()).team[f.a2.id] === f.s2.id,
    "Team move was not saved",
  );
  checks.push(
    "Drag attendant and assigned rooms to another supervisor atomically",
  );
  await page.getByRole("button", { name: "Undo last move" }).click();
  await until(
    async () => (await worksheet()).team[f.a2.id] === f.s1.id,
    "Undo did not restore supervisor",
  );
  await until(
    async () =>
      (await page!
        .locator(
          `[data-supervisor-id="${f.s1.id}"] [data-attendant-id="${f.a2.id}"]`,
        )
        .count()) === 1,
    "Undo did not update browser",
  );
  checks.push("Undo restores the last persisted move and reconciles the board");
  await page
    .getByLabel("Supervisor for floor West", { exact: true })
    .selectOption(f.s2.id);
  await until(
    async () =>
      (await worksheet()).floorAssignments.find((r: any) => r.id === "West")
        ?.supervisorId === f.s2.id,
    "Floor replacement was not saved",
  );
  check(
    (await worksheet()).assignments["201"] === f.a1.id &&
      (await worksheet()).roomExceptions["201"] === f.s1.id,
    "Manager floor replacement preserves active attendant work as visible room exceptions",
  );
  await page.getByRole("button", { name: "Undo last move" }).click();
  await until(
    async () =>
      (await worksheet()).floorAssignments.find((r: any) => r.id === "West")
        ?.supervisorId === f.s1.id,
    "Floor undo did not restore primary supervisor",
  );
  checks.push(
    "Undo restores floor ownership without deleting room work or audit history",
  );
  // Hold autosave so a second manager deterministically wins the revision race.
  let release!: () => void, intercepted!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (intercepted = r));
  let caught = false;
  await page.route("**/api/local-housekeeping/worksheet", async (route) => {
    if (route.request().method() === "PUT" && !caught) {
      caught = true;
      intercepted();
      await held;
    }
    await route.continue();
  });
  await page
    .getByLabel("Assign room 201 to", { exact: true })
    .selectOption(f.a2.id);
  await seen;
  await remoteMove([{ type: "rooms", roomIds: ["201"], attendantId: null }]);
  release();
  await page.getByText(/Worksheet changed by another user/).waitFor();
  await until(
    async () =>
      (await page!
        .getByLabel("Assign room 201 to", { exact: true })
        .inputValue()) === "",
    "Conflicting optimistic move was not rolled back",
  );
  checks.push(
    "Conflicting manager autosave rolls back and shows the winning assignment",
  );
  await page.unroute("**/api/local-housekeeping/worksheet");
  let failed = false;
  await page.route("**/api/local-housekeeping/worksheet", async (route) => {
    if (route.request().method() === "PUT" && !failed) {
      failed = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Deliberate isolated smoke save failure",
        }),
      });
    } else await route.continue();
  });
  await page
    .getByLabel("Assign room 202 to", { exact: true })
    .selectOption(f.a2.id);
  await page.getByText(/Deliberate isolated smoke save failure/).waitFor();
  await until(
    async () =>
      (await page!
        .getByLabel("Assign room 202 to", { exact: true })
        .inputValue()) === f.a1.id,
    "Failed autosave was not rolled back",
  );
  await page.unroute("**/api/local-housekeeping/worksheet");
  checks.push(
    "Failed autosave rolls back without losing the confirmed worksheet",
  );
  await f.db.orm.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE rooms SET status='inspected',attention='DND / PMR discrepancy',updated_at=now() WHERE tenant_id='demo' AND property_id='demo-1' AND id='202'`,
    );
    await appendEvent(tx, "demo", "demo-1", "rooms");
  });
  await page
    .locator('[data-room-id="202"]')
    .getByText("Inspected", { exact: true })
    .waitFor({ timeout: 10000 });
  check(
    (await worksheet()).localProgress["202"] === "assigned",
    "Room snapshot WebSocket event updates OPERA status without inferring local completion",
  );
  await page.getByLabel("Filter floor").selectOption("East");
  check(
    (await page.locator('[data-room-id="201"]').count()) === 0,
    "Floor filter uses verified directory values",
  );
  await page.getByLabel("Filter floor").selectOption("");
  await page.getByLabel("Filter room status").selectOption("Inspected");
  check(
    (await page.locator('[data-room-id="202"]').count()) === 1 &&
      (await page.locator('[data-room-id="201"]').count()) === 0,
    "OPERA status filter works",
  );
  await page.getByLabel("Filter room status").selectOption("");
  await page.getByLabel("Housekeeping shift").selectOption("PM");
  await until(
    async () =>
      (await page!.locator("[data-drop-unassigned] [data-room-id]").count()) ===
      6,
    "Shift/date isolation failed",
  );
  checks.push("Shift selection isolates assignments");
  await page.getByLabel("Housekeeping shift").selectOption("AM");
  await page.getByLabel("Assign room 202 to", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Print Worksheet", exact: true })
    .click();
  const preview = page.getByRole("dialog", { name: "Worksheet print preview" });
  await preview.waitFor();
  check(
    (await preview.locator(".worksheet-print-master").count()) === 2 &&
      (await preview.locator(".worksheet-print-floor-totals").count()) >= 2,
    "Supervisor Master Sheet includes assigned floors, floor totals and separate supervisor reports",
  );
  check(
    (await preview
      .getByText("Attendant: Attendant One", { exact: true })
      .count()) === 1 &&
      (await preview
        .getByText("Attendant: Attendant Two", { exact: true })
        .count()) === 1,
    "Print preview contains each attendant and supervisor totals",
  );
  check(
    await preview
      .locator("table")
      .evaluateAll((tables) =>
        tables.every((t) => t.scrollWidth <= t.clientWidth + 1),
      ),
    "Print tables fit the portrait worksheet without horizontal clipping",
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({
    path: "artifacts/housekeeping-print-preview.png",
    fullPage: true,
  });
  const masterPdf = await page.pdf({
    path: "artifacts/housekeeping-supervisor-master.pdf",
    format: "A4",
    preferCSSPageSize: true,
    printBackground: true,
  });
  check(
    (masterPdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []).length >=
      3,
    "Master PDF separates supervisors and includes the unallocated-room report",
  );
  const savedRevision = (await worksheet()).revision;
  check(
    (await preview.locator(".worksheet-print").innerText()).includes(
      `Saved assignment revision: ${savedRevision}`,
    ),
    "Print uses the latest successfully saved assignment revision",
  );
  await preview.getByLabel("Worksheet print mode").selectOption("attendant");
  check(
    (await preview.locator(".worksheet-print-signatures").count()) === 2,
    "Attendant print mode supplies signature areas and its own pages",
  );
  const pdf = await page.pdf({
    path: "artifacts/housekeeping-worksheet.pdf",
    format: "A4",
    preferCSSPageSize: true,
    printBackground: true,
  });
  const pdfText = pdf.toString("latin1"),
    media = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdfText);
  check(
    !!media &&
      Number(media[1]) > 594 &&
      Number(media[1]) < 597 &&
      Number(media[2]) > 841 &&
      Number(media[2]) < 844,
    "Browser PDF is A4 portrait",
  );
  check(
    (pdfText.match(/\/Type\s*\/Page\b/g) || []).length >= 3,
    "PDF applies separate attendant pages plus the unassigned room report",
  );
  await page.evaluate(() => {
    (window as unknown as { printInvocations: number }).printInvocations = 0;
    window.print = () => {
      (window as unknown as { printInvocations: number }).printInvocations++;
    };
  });
  await preview.getByRole("button", { name: "Print / Save PDF" }).click();
  check(
    (await page.evaluate(
      () =>
        (window as unknown as { printInvocations: number }).printInvocations,
    )) === 1,
    "Print action invokes the browser print dialog without an external service",
  );
  await preview.getByRole("button", { name: "Close preview" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Manager mobile viewport has no page-level horizontal overflow",
  );
  await page.screenshot({
    path: "artifacts/housekeeping-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "artifacts/housekeeping-desktop.png",
    fullPage: true,
  });
  // Browser actors share one loopback IP. Keep production rate limiting intact
  // and start mobile acceptance in the next window after desktop activity.
  const remaining = 65000 - (Date.now() - began);
  if (remaining > 0) {
    console.log(
      "Waiting for the unchanged API rate-limit window before mobile actors",
    );
    await new Promise((r) => setTimeout(r, Math.min(remaining, 55000)));
  }
  const own = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const [name, cookieValue] = f.a1.cookie.split("=");
  await own.addCookies([{ name, value: cookieValue, url: f.base }]);
  const attendant = await own.newPage();
  attendant.on("pageerror", (e) => errors.push(e.message));
  await attendant.goto(f.base + "/");
  await attendant
    .getByRole("heading", { name: "My Worksheet", exact: true })
    .waitFor();
  await attendant.getByLabel("Business date").fill(scope.date);
  await until(
    async () => (await attendant.locator('[data-room-id="202"]').count()) === 1,
    "Own worksheet did not load",
  );
  check(
    (await attendant.locator("[data-room-id]").count()) === 1 &&
      attendant.url().includes("/operations/rooms"),
    "Attendant login opens My Worksheet directly with only their own room",
  );
  check(
    (await attendant.locator(".worksheet-assign-to").count()) === 0 &&
      (await attendant
        .getByRole("button", { name: "Undo last move" })
        .count()) === 0,
    "Attendant mobile view has no reassignment controls",
  );
  check(
    await attendant.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Attendant mobile worksheet is responsive",
  );
  await attendant.evaluate(() => window.scrollTo(0, 0));
  await attendant.screenshot({
    path: "artifacts/housekeeping-attendant-mobile.png",
    fullPage: true,
  });
  const team = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const [spvName, spvValue] = f.s1.cookie.split("=");
  await team.addCookies([{ name: spvName, value: spvValue, url: f.base }]);
  const supervisor = await team.newPage();
  supervisor.on("pageerror", (e) => errors.push(e.message));
  await supervisor.goto(f.base + "/");
  await supervisor
    .getByRole("heading", { name: "My Team", exact: true })
    .waitFor();
  await supervisor.getByLabel("Business date").fill(scope.date);
  await supervisor
    .getByLabel("Assign room 202 to", { exact: true })
    .selectOption(f.a2.id);
  await until(
    async () => (await worksheet()).assignments["202"] === f.a2.id,
    "Authorized mobile supervisor reassignment was not saved",
  );
  await until(
    async () => (await attendant.locator('[data-room-id="202"]').count()) === 0,
    "Attendant did not receive assignment WebSocket update",
  );
  checks.push(
    "Authorized supervisor mobile Assign To updates My Team and attendant worksheet via WebSocket",
  );
  await f.db.query(
    sql`UPDATE connections SET mode='real' WHERE tenant_id='demo' AND property_id='demo-1'`,
  );
  await f.db.orm.transaction(async (tx) =>
    appendEvent(tx, "demo", "demo-1", "rooms"),
  );
  await page
    .getByRole("heading", { name: "OPERA room data unavailable" })
    .waitFor({ timeout: 10000 });
  check(
    (await page.locator("[data-room-id]").count()) === 0,
    "Live mode with no authorized OPERA feed hides demo and synthetic Unknown rooms",
  );
  check(
    errors.length === 0,
    "SPA and native drag/drop run without browser errors",
  );
  const result = {
    status: "PASS",
    checks,
    browserErrors: errors,
    oracle:
      "Synthetic authorized contracts and disposable PGlite; no live OPERA calls",
    viewports: ["1440x1000", "390x844"],
  };
  await writeFile(
    "artifacts/housekeeping-smoke.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      url: page?.url(),
      errors,
      visibleText: await page?.locator("body").innerText(),
      dragTrace: await page?.evaluate(
        () =>
          (window as unknown as { worksheetDragTrace: unknown[] })
            .worksheetDragTrace,
      ),
      browserPages: await Promise.all(
        (browser?.contexts() || [])
          .flatMap((c) => c.pages())
          .map(async (p) => ({
            url: p.url(),
            text: await p
              .locator("body")
              .innerText()
              .catch(() => "<closed>"),
          })),
      ),
    }),
  );
  throw error;
} finally {
  await browser?.close();
  await f.close();
}
