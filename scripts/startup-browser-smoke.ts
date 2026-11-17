import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import staticFiles from "@fastify/static";
import { openDb, migrate } from "../apps/api/src/db.js";
import { buildApp } from "../apps/api/src/app.js";
import { seed } from "../apps/api/src/seed.js";
import { frontendPath } from "../apps/api/src/paths.js";

const host = "192.168.1.122";
const label = process.env.STARTUP_SMOKE_LABEL || "after";
await mkdir("artifacts/startup", { recursive: true });
const db = await openDb(true);
const password = randomBytes(18).toString("hex");
await migrate(db);
await seed(db, password);
process.env.APP_ORIGIN = `http://${host}`;
const app = await buildApp(db);
await app.register(staticFiles, { root: frontendPath });
app.setNotFoundHandler((req, reply) =>
  req.headers.accept?.includes("text/html") &&
  !req.url.startsWith("/api/") &&
  !req.url.startsWith("/assets/")
    ? reply.sendFile("index.html")
    : reply.code(404).send({ error: "Not found" }),
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const evidence: Record<string, any> = {
  console: [],
  pageerrors: [],
  failed: [],
  assets: [],
  websockets: [],
  checks: [],
};
try {
  await app.listen({ host, port: 0 });
  const port = (app.server.address() as { port: number }).port;
  const origin = `http://${host}:${port}`;
  process.env.APP_ORIGIN = origin;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  evidence.apiOrigins = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/") &&
      !evidence.apiOrigins.includes(url.origin)
    )
      evidence.apiOrigins.push(url.origin);
  });
  page.on("pageerror", (e) => evidence.pageerrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") evidence.console.push(m.text());
  });
  page.on("requestfailed", (r) =>
    evidence.failed.push({
      path: new URL(r.url()).pathname,
      error: r.failure()?.errorText,
    }),
  );
  page.on("response", (r) => {
    if (/\.(js|css)$/.test(r.url()))
      evidence.assets.push({
        path: new URL(r.url()).pathname,
        status: r.status(),
        type: r.headers()["content-type"],
      });
  });
  page.on("websocket", (ws) =>
    evidence.websockets.push(ws.url().split("?")[0]),
  );
  const response = await page.goto(origin, { waitUntil: "networkidle" });
  evidence.csp = response?.headers()["content-security-policy"];
  await page.screenshot({ path: `artifacts/startup/${label}-desktop.png` });
  evidence.root = await page.locator("#root").innerText();
  if (process.env.STARTUP_SMOKE_LABEL === "before") returnEvidence();
  else {
    await page.getByLabel("Email address").fill("admin@demo.local");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: /Sign in/ }).click();
    await page
      .getByRole("link", { name: "Rooms & Housekeeping", exact: true })
      .waitFor();
    evidence.checks.push("Authenticated shell rendered");
    await page
      .getByText("Browser WebSocket: Connected", { exact: true })
      .waitFor();
    evidence.checks.push("Authenticated WebSocket connected");
    await page
      .getByRole("link", { name: "Rooms & Housekeeping", exact: true })
      .click();
    await page.waitForTimeout(1800);
    evidence.housekeeping = await page.locator("main").innerText();
    await page.screenshot({
      path: `artifacts/startup/${label}-housekeeping.png`,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    evidence.mobileRoot = (await page.locator("#root").innerText()).length;
    await page.screenshot({ path: `artifacts/startup/${label}-mobile.png` });
    evidence.checks.push(
      "Mobile LAN viewport rendered",
      "Housekeeping route rendered",
    );
    if (
      evidence.apiOrigins.some((value: string) => value !== origin) ||
      evidence.websockets.some(
        (value: string) => new URL(value).host !== new URL(origin).host,
      )
    )
      throw Error("Browser API/WebSocket origin mismatch");
    if (
      evidence.pageerrors.length ||
      evidence.failed.length ||
      evidence.assets.some(
        (a: any) =>
          ![200, 304].includes(a.status) ||
          (a.status === 200 && !/javascript|css/.test(a.type)),
      )
    )
      throw Error("Browser checks failed");
    const failurePage = await context.newPage();
    await failurePage.route("**/assets/boot-*.js", (route) => route.abort());
    await failurePage.goto(origin);
    await failurePage
      .getByRole("heading", {
        name: "Application could not start",
        exact: true,
      })
      .waitFor();
    await failurePage.screenshot({
      path: `artifacts/startup/${label}-startup-error.png`,
    });
    evidence.checks.push("Failed React chunk shows visible startup error");
    await failurePage.close();
    evidence.success = true;
  }
} finally {
  await writeFile(
    `artifacts/startup/${label}-browser.json`,
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
  await browser.close();
  await app.close();
  await db.close();
}
function returnEvidence() {
  evidence.checks.push("Before-change evidence captured");
}
