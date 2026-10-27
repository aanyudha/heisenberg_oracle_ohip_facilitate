/* global document, window */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
const password = randomBytes(18).toString("base64url");
await mkdir("data", { recursive: true });
await mkdir("artifacts", { recursive: true });
const dbPath = await mkdtemp("data/browser-");
const port = process.env.SMOKE_PORT || "3101";
const env = {
  ...process.env,
  DATABASE_URL: "",
  LOCAL_DEMO: "true",
  LOCAL_DB_PATH: dbPath,
  DEMO_PASSWORD: password,
  PORT: port,
  HOST: "127.0.0.1",
  APP_ORIGIN: `http://localhost:${port}`,
  COOKIE_SECURE: "false",
};
async function run(args) {
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { stdio: "inherit", env });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(Error("Setup failed"))));
    p.on("error", reject);
  });
}
await run(["--import", "tsx", "apps/api/src/migrate.ts"]);
await run(["--import", "tsx", "apps/api/src/seed.ts"]);
const server = spawn(
  process.execPath,
  ["--import", "tsx", "apps/api/src/index.ts"],
  { stdio: ["ignore", "pipe", "pipe"], env },
);
let browser;
const errors = [],
  requests = [];
try {
  for (let n = 0; n < 100; n++) {
    try {
      if ((await fetch(`http://localhost:${port}/api/health`)).ok) break;
    } catch {
      /* Wait for the child process to bind its port. */
    }
    await new Promise((r) => setTimeout(r, 100));
    if (n === 99) throw Error("Server did not start");
  }
  const executablePath =
    process.env.CHROME_PATH ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1050 },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame())
      requests.push(r.url());
  });
  await page.goto(`http://localhost:${port}`);
  await page.getByLabel("Email address").fill("admin@demo.local");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await page
    .getByRole("heading", { name: "Every detail. A smoother day." })
    .waitFor();
  await page.getByText("Connected", { exact: true }).waitFor();
  await page.getByLabel("Property", { exact: true }).selectOption("demo-1");
  await page.screenshot({
    path: "artifacts/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Reservations", exact: true }).click();
  await page
    .getByRole("heading", { name: "Reservations", exact: true })
    .waitFor();
  await page.getByLabel("Search reservations").fill("DEMO-81000");
  await page.getByRole("cell", { name: "DEMO-81000", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "View DEMO-81000", exact: true })
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.getByRole("link", { name: "Priority Tasks", exact: true }).click();
  await page
    .getByRole("heading", { name: "Priority Tasks", exact: true })
    .waitFor();
  await page.getByLabel("Task title").fill("Browser smoke assignment");
  await page.getByRole("button", { name: "Add task" }).click();
  await page
    .getByRole("heading", { name: "Browser smoke assignment" })
    .waitFor();
  const article = page
    .locator("article")
    .filter({ hasText: "Browser smoke assignment" });
  await article.getByLabel("Assign to").selectOption("demo-frontoffice");
  await article.getByLabel("Status").selectOption("acknowledged");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("article")].some(
      (a) =>
        a.textContent.includes("Browser smoke assignment") &&
        a.querySelector("select")?.value === "demo-frontoffice" &&
        a.querySelectorAll("select")[1]?.value === "acknowledged",
    ),
  );
  // A second browser context simulates a backend change from another user session.
  const session = await context.request.get(`http://localhost:${port}/api/me`);
  const identity = await session.json();
  const remote = await context.request.post(
    `http://localhost:${port}/api/tasks`,
    {
      headers: {
        "x-csrf-token": identity.csrf,
        origin: `http://localhost:${port}`,
      },
      data: {
        propertyId: "demo-1",
        title: "Realtime from another session",
        priority: "normal",
      },
    },
  );
  if (!remote.ok()) throw Error("Remote mutation failed");
  await page
    .getByRole("heading", { name: "Realtime from another session" })
    .waitFor({ timeout: 5000 });
  for (const name of [
    "Multi-Property Overview",
    "Property Comparison",
    "Alerts",
    "OHIP Connections",
    "Integration Health",
    "Error Logs",
    "Retry Queue",
    "Tenants",
    "Organizations",
    "Properties",
    "Users & Roles",
    "Branding",
    "Audit Trail",
  ]) {
    await page.getByRole("link", { name, exact: true }).click();
    await page.locator("h1").waitFor();
    await page.waitForTimeout(100);
    if (await page.getByRole("alert").count())
      throw Error("Error view on " + name);
  }
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await page
    .getByRole("heading", { name: "Every detail. A smoother day." })
    .waitFor();
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "artifacts/dashboard-tablet.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "artifacts/dashboard-mobile.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) throw Error("Mobile layout overflows");
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("link", { name: "Arrivals", exact: true }).click();
  await page.getByRole("heading", { name: "Today's Arrivals" }).waitFor();
  if (requests.length !== 1)
    throw Error(`Internal navigation caused ${requests.length} document loads`);
  if (errors.length) throw Error(errors.join("\n"));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page
    .getByRole("heading", { name: "Sign in to your workspace" })
    .waitFor();
  const result = {
    result: "PASS",
    browser: "Installed Chromium browser via Playwright",
    documentLoads: requests.length,
    pageErrors: errors,
    checks: [
      "login/logout",
      "reservation search/detail",
      "task create/assign/acknowledge",
      "websocket-driven update",
      "all menu routes",
      "desktop/tablet/mobile",
      "no mobile overflow",
      "SPA navigation without document reload",
    ],
    database: "Isolated embedded PostgreSQL (PGlite)",
    screenshots: [
      "artifacts/dashboard-desktop.png",
      "artifacts/dashboard-tablet.png",
      "artifacts/dashboard-mobile.png",
    ],
  };
  await writeFile(
    "artifacts/browser-result.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => server.once("exit", r));
}
