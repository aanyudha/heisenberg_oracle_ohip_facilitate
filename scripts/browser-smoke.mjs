/* global document, window */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { chromium } from "playwright";
const runId = randomBytes(4).toString("hex");
const assignmentTitle = "Browser smoke assignment " + runId,
  remoteTitle = "Realtime from another session " + runId,
  reconnectTitle = "Realtime after restart " + runId;
const docker = process.env.SMOKE_DOCKER === "true";
const password =
  process.env.SMOKE_PASSWORD || randomBytes(18).toString("base64url");
await mkdir("data", { recursive: true });
await mkdir("artifacts", { recursive: true });
const dbPath = await mkdtemp("data/browser-");
const port = process.env.SMOKE_PORT || "3000";
const env = {
  ...process.env,
  NODE_ENV: "development",
  APP_MODE: "demo",
  DATABASE_URL: "",
  LOCAL_DEMO: "true",
  LOCAL_DB_PATH: dbPath,
  DEMO_PASSWORD: password,
  PORT: port,
  HOST: "127.0.0.1",
  APP_ORIGIN: `http://localhost:${port}`,
  COOKIE_SECURE: "false",
};
function launch() {
  const child = spawn(process.execPath, ["dist/server/index.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    windowsHide: true,
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  child.kill();
  await exited;
}
if (
  !docker &&
  (await fetch(`http://localhost:${port}/api/health`).then(
    () => true,
    () => false,
  ))
)
  throw Error(
    `Port ${port} is occupied. Stop the other deployment before testing native mode.`,
  );
let server = docker ? undefined : launch();
async function ready() {
  for (let n = 0; n < 300; n++) {
    try {
      if ((await fetch(`http://localhost:${port}/api/health`)).ok) return;
    } catch {
      /* Wait for startup. */
    }
    if (server?.exitCode !== null && server?.exitCode !== undefined)
      throw Error("Compiled server exited");
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Server did not start");
}
let browser;
const errors = [],
  requests = [];
try {
  await ready();
  const html = await (await fetch(`http://localhost:${port}`)).text();
  const frontendHash = createHash("sha256").update(html).digest("hex");
  for (const path of ["/api/missing", "/assets/missing.js"]) {
    const response = await fetch(`http://localhost:${port}${path}`, {
      headers: { accept: "text/html" },
    });
    if (
      ![401, 404].includes(response.status) ||
      response.headers.get("content-type")?.includes("text/html")
    )
      throw Error("Missing resources must not return SPA HTML");
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
  let socketCount = 0,
    socketCloses = 0;
  page.on("websocket", (socket) => {
    socketCount++;
    socket.on("close", () => socketCloses++);
  });
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
  await page.getByLabel("Task title").fill(assignmentTitle);
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByRole("heading", { name: assignmentTitle }).waitFor();
  const article = page.locator("article").filter({ hasText: assignmentTitle });
  await article.getByLabel("Assign to").selectOption("demo-frontoffice");
  await article.getByLabel("Status").selectOption("acknowledged");
  await page.waitForFunction(
    (title) =>
      [...document.querySelectorAll("article")].some(
        (a) =>
          a.textContent.includes(title) &&
          a.querySelector("select")?.value === "demo-frontoffice" &&
          a.querySelectorAll("select")[1]?.value === "acknowledged",
      ),
    assignmentTitle,
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
        title: remoteTitle,
        priority: "normal",
      },
    },
  );
  if (!remote.ok()) throw Error("Remote mutation failed");
  await page
    .getByRole("heading", { name: remoteTitle })
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
  const spaDocumentLoads = requests.length;
  if (socketCount !== 1 || socketCloses !== 0)
    throw Error("Page navigation interrupted the WebSocket session");
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("link", { name: "Priority Tasks", exact: true }).click();
  await page.getByRole("heading", { name: assignmentTitle }).waitFor();
  if (docker) {
    await new Promise((resolve, reject) => {
      const p = spawn(
        "docker",
        [
          "--config",
          ".docker-local",
          "compose",
          "-p",
          "hospitality-deploy-validation",
          "restart",
          "app",
        ],
        { stdio: "inherit", windowsHide: true },
      );
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? resolve() : reject(Error("Docker restart failed")),
      );
    });
  } else {
    await stop(server);
    server = launch();
  }
  await ready();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".connection")].some(
        (n) => n.textContent === "Connected",
      ),
    {},
    { timeout: 30000 },
  );
  if (socketCount < 2 || socketCloses < 1)
    throw Error("WebSocket did not reconnect after restart");
  const persisted = await context.request.get(
    `http://localhost:${port}/api/tasks?propertyId=demo-1`,
  );
  if (!persisted.ok()) throw Error("Session did not survive database restart");
  const stored = (await persisted.json()).items.find(
    (t) => t.title === assignmentTitle,
  );
  if (
    !stored ||
    stored.assignee !== "demo-frontoffice" ||
    stored.status !== "acknowledged"
  )
    throw Error("Task data did not persist after restart");
  const second = await context.request.post(
    `http://localhost:${port}/api/tasks`,
    {
      headers: {
        "x-csrf-token": identity.csrf,
        origin: `http://localhost:${port}`,
      },
      data: {
        propertyId: "demo-1",
        title: reconnectTitle,
        priority: "normal",
      },
    },
  );
  if (!second.ok()) throw Error("Post-reconnect mutation failed");
  await page
    .getByRole("heading", { name: reconnectTitle })
    .waitFor({ timeout: 5000 });
  await page.goto(`http://localhost:${port}/operations/reservations`);
  await page
    .getByRole("heading", { name: "Reservations", exact: true })
    .waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "Reservations", exact: true })
    .waitFor();
  if (errors.length) throw Error(errors.join("\n"));
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await page
    .getByRole("heading", { name: "Sign in to your workspace" })
    .waitFor();
  const result = {
    result: "PASS",
    deployment: docker ? "docker" : "native",
    frontendHash,
    browser: "Installed Chromium browser via Playwright",
    spaDocumentLoads,
    documentLoads: requests.length,
    socketCount,
    socketCloses,
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
      "same WebSocket across page navigation",
      "server restart and WebSocket reconnect",
      "database and session persistence after restart",
      "realtime updates after reconnect",
      "nested SPA route refresh",
      "missing API/assets never return SPA HTML",
    ],
    database: docker
      ? "PostgreSQL in Compose persistent volume"
      : "Isolated persistent embedded PostgreSQL (PGlite)",
    screenshots: [
      "artifacts/dashboard-desktop.png",
      "artifacts/dashboard-tablet.png",
      "artifacts/dashboard-mobile.png",
    ],
  };
  await writeFile(
    `artifacts/browser-${docker ? "docker" : "native"}-result.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await stop(server);
}
