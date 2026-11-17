/* global window, location */
import { fork } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { chromium } from "playwright";
const data = resolve("data");
await mkdir(data, { recursive: true });
await mkdir("artifacts/startup", { recursive: true });
const root = await mkdtemp(resolve(data, "startup-runtime-"));
if (!root.startsWith(data + sep + "startup-runtime-"))
  throw Error("Unexpected test workspace path");
await cp("dist", resolve(root, "dist"), { recursive: true });
await writeFile(
  resolve(root, "package.json"),
  JSON.stringify({ type: "module" }),
);
const password = randomBytes(24).toString("hex"),
  key = randomBytes(32).toString("hex");
const host = "192.168.1.122";
const socket = createServer();
await new Promise((r, j) => {
  socket.once("error", j);
  socket.listen(0, host, r);
});
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const environment = {
  APP_MODE: "native",
  NODE_ENV: "test",
  APP_HOST: host,
  APP_PORT: String(port),
  APP_URL: `http://${host}:${port}`,
  DB_TYPE: "embedded",
  DB_FILE: "./db",
  ENCRYPTION_KEY: key,
  DEMO_SEED: "true",
  DEMO_PASSWORD: password,
  COOKIE_SECURE: "false",
};
const writeEnv = (env) =>
  writeFile(
    resolve(root, ".env"),
    Object.entries(env)
      .map(([k, v]) => `${k}='${v}'`)
      .join("\n"),
  );
const owned = new Set();
function launch() {
  const child = fork(resolve(root, "dist/server/index.js"), [], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  owned.add(child);
  child.output = "";
  child.exited = once(child, "exit");
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      child.output = (child.output + data.toString()).slice(-65536);
    });
  return child;
}
async function ready(child) {
  for (let n = 0; n < 300; n++) {
    const line = child.output
      .split("\n")
      .find((line) => line.startsWith('{"event":"application_ready"'));
    if (line) return JSON.parse(line);
    if (child.exitCode !== null)
      throw Error("Disposable startup failed: " + child.output);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Disposable startup timed out");
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.send("shutdown");
  const exit = await Promise.race([
    child.exited,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(Error("Owned test child shutdown timeout")),
        10000,
      );
      timer.unref();
    }),
  ]);
  if (exit[0] !== 0) throw Error("Graceful test shutdown failed");
}
const proof = {
  checks: [],
  reports: [],
  browser: { pageerrors: [], failed: [] },
};
let browser;
try {
  await writeEnv(environment);
  const child = launch(),
    report = await ready(child);
  proof.reports.push(report);
  if (report.database.migration.applied !== 6)
    throw Error("Fresh startup did not migrate");
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (e) => proof.browser.pageerrors.push(e.message));
  page.on("requestfailed", (r) =>
    proof.browser.failed.push(new URL(r.url()).pathname),
  );
  let closeCode;
  page.on("websocket", (ws) => ws.on("close", () => {}));
  await page.goto(environment.APP_URL, { waitUntil: "networkidle" });
  await page.getByLabel("Email address").fill("admin@demo.local");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /Sign in/ }).click();
  await page
    .getByText("Browser WebSocket: Connected", { exact: true })
    .waitFor();
  closeCode = page.evaluate(
    () =>
      new Promise((resolve) => {
        const original = window.WebSocket;
        // Observe an additional authenticated same-origin socket using current CSRF.
        fetch("/api/me")
          .then((r) => r.json())
          .then((me) => {
            const ws = new original(
              `ws://${location.host}/api/ws?csrf=${encodeURIComponent(me.csrf)}`,
            );
            ws.onclose = (e) => resolve(e.code);
            ws.onerror = () => {};
          });
      }),
  );
  await page.waitForTimeout(300);
  await stop(child);
  if ((await closeCode) !== 1001)
    throw Error("Shutdown did not close WS with Going Away");
  proof.checks.push(
    "Fresh compiled startup migrated once and rendered login/authenticated shell",
    "Graceful IPC shutdown closed authenticated WebSocket with 1001",
  );
  await browser.close();
  browser = undefined;
  await writeEnv({ ...environment, DEMO_SEED: "false" });
  const repeat = launch(),
    upToDate = await ready(repeat);
  proof.reports.push(upToDate);
  if (upToDate.database.migration.applied !== 0)
    throw Error("Repeated startup reapplied migrations");
  const concurrent = launch();
  const concurrentExit = await concurrent.exited;
  if (
    concurrentExit[0] === 0 ||
    !concurrent.output.includes("Another deployment")
  )
    throw Error("Concurrent startup lease did not block the second child");
  await stop(repeat);
  proof.checks.push(
    "Repeated compiled npm-start entry preserved DB and skipped applied migrations",
    "Concurrent compiled startup blocked by shared deployment lease",
  );
  await writeFile(
    resolve(root, "dist/migrations/0007_runtime_fixture.sql"),
    "ALTER TABLE tenants ADD COLUMN runtime_fixture text;",
  );
  await writeEnv({ ...environment, DEMO_SEED: "false", APP_HOST: "0.0.0.0" });
  const additive = launch(),
    additiveReport = await ready(additive);
  proof.reports.push(additiveReport);
  if (
    additiveReport.database.migration.applied !== 1 ||
    additiveReport.database.migration.current !== "0007"
  )
    throw Error("Compiled startup did not apply pending additive migration");
  if (
    !(await fetch(`http://127.0.0.1:${port}/api/health`)).ok ||
    !(await fetch(`${environment.APP_URL}/api/health`)).ok
  )
    throw Error("Explicit all-interface binding failed");
  await stop(additive);
  proof.checks.push(
    "Future compiled start applies one pending additive migration",
    "Explicit 0.0.0.0 serves LAN and loopback while APP_URL stays LAN",
  );
  const badConfig = {
    ...environment,
    APP_HOST: "192.0.2.88",
    APP_URL: `http://192.0.2.88:${port}`,
    DEMO_SEED: "false",
  };
  await writeEnv(badConfig);
  const failed = launch();
  const failedExit = await failed.exited;
  if (
    failedExit[0] === 0 ||
    failed.output.includes('"event":"application_ready"') ||
    !failed.output.includes("Cannot bind APP_HOST")
  )
    throw Error("Invalid binding did not fail safely");
  proof.checks.push("Unavailable bind IP exits nonzero without READY");
  const listener = createServer();
  await new Promise((r, j) => {
    listener.once("error", j);
    listener.listen(port, host, r);
  });
  try {
    await writeEnv({ ...environment, DEMO_SEED: "false" });
    const conflict = launch();
    const exit = await conflict.exited;
    if (
      exit[0] === 0 ||
      !conflict.output.includes("already in use") ||
      conflict.output.includes('"event":"application_ready"')
    )
      throw Error("Port conflict did not fail safely");
  } finally {
    await new Promise((r) => listener.close(r));
  }
  proof.checks.push("Occupied test port exits nonzero with actionable error");
  await writeEnv({
    ...environment,
    DEMO_SEED: "false",
    DB_TYPE: "postgres",
    DB_HOST: "127.0.0.1",
    DB_PORT: "1",
    DB_USER: "startup_test",
    DB_PASSWORD: password,
  });
  const unavailable = launch();
  const unavailableExit = await unavailable.exited;
  if (
    unavailableExit[0] === 0 ||
    !unavailable.output.includes("Database connection failed") ||
    unavailable.output.includes('"event":"application_ready"')
  )
    throw Error("Unavailable DB did not fail before READY");
  proof.checks.push(
    "Unavailable configured PostgreSQL fails without fallback or READY",
  );
  const manifest = JSON.parse(
    await readFile(resolve(root, "dist/public/.vite/manifest.json"), "utf8"),
  );
  const lazy = Object.values(manifest).find((chunk) =>
    chunk.file.includes("Operations-"),
  );
  if (!lazy) throw Error("No lazy chunk in test manifest");
  await rm(resolve(root, "dist/public", lazy.file));
  await writeEnv({ ...environment, DEMO_SEED: "false" });
  const missing = launch();
  const missingExit = await missing.exited;
  if (
    missingExit[0] === 0 ||
    !missing.output.includes("Frontend asset is missing") ||
    missing.output.includes('"event":"application_ready"')
  )
    throw Error("Missing lazy asset did not fail safely");
  proof.checks.push(
    "Missing lazy frontend asset fails before DB migration/HTTP readiness",
  );
  // Check every child's bounded output for synthetic secrets before publishing.
  for (const child of owned)
    if (child.output.includes(password) || child.output.includes(key))
      throw Error("Secret detected in child logs");
  proof.success = true;
  await writeFile(
    "artifacts/startup/runtime-smoke.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(JSON.stringify({ success: true, checks: proof.checks }));
} finally {
  await browser?.close();
  for (const child of owned)
    if (child.exitCode === null) {
      try {
        await stop(child);
      } catch {
        child.kill();
        await child.exited;
      }
    }
  // Exact mkdtemp child was verified under the workspace data directory above.
  await rm(root, { recursive: true, force: true });
}
