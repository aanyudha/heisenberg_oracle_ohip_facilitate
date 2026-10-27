import { spawn } from "node:child_process";
import { readFile, writeFile, rm, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "dotenv";
const original = await readFile(".env", "utf8");
// Test credentials are isolated from the user's runtime secrets.
const base = {
  ...parse(original),
  ENCRYPTION_KEY: randomBytes(32).toString("hex"),
};
const id = randomBytes(5).toString("hex");
const project = "hospitality-config-test-" + id;
const pgContainer = project + "-native-pg";
const secret = randomBytes(20).toString("hex") + "$:#@/%";
const demoSecret = randomBytes(20).toString("hex");
const report = [];
let pgCreated = false,
  composeAttempted = false;
const compose = ["compose", "-p", project];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function command(binary, args, extraEnv = {}, allowFailure = false) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
  if (result.output.includes(secret) || result.output.includes(demoSecret))
    throw Error("Secret appeared in command output");
  if (result.code && !allowFailure)
    throw Error(binary + " failed: " + result.output);
  return result;
}
async function configure(values) {
  await writeFile(
    ".env",
    Object.entries({ ...base, ...values })
      .map(([k, v]) => `${k}='${v}'`)
      .join("\n"),
  );
}
function pass(check) {
  report.push({ check, status: "PASS" });
  console.log("PASS: " + check);
}
async function startupFails(values, expected, cli = "index") {
  await configure(values);
  const r = await command(
    process.execPath,
    [`dist/server/${cli}.js`],
    {},
    true,
  );
  if (!r.code || !r.output.includes(expected))
    throw Error("Expected startup failure: " + expected + "; " + r.output);
}
try {
  await mkdir("artifacts", { recursive: true });
  await mkdir("data", { recursive: true });
  await rename(".env", "data/config-test-" + id + ".backup");
  try {
    const missing = await command(
      process.execPath,
      ["dist/server/validate-config.js"],
      {},
      true,
    );
    if (!missing.code || !missing.output.includes("Copy .env.example"))
      throw Error("Missing .env did not produce setup instructions");
    pass("Missing root .env shows setup instructions");
  } finally {
    await rename("data/config-test-" + id + ".backup", ".env");
  }
  for (const [values, expected] of [
    [{ APP_MODE: "invalid" }, "APP_MODE"],
    [{ DB_TYPE: "invalid" }, "DB_TYPE"],
    [
      { APP_MODE: "docker", DB_TYPE: "postgres", DB_PASSWORD: secret },
      "does not match native startup",
    ],
    [
      { APP_MODE: "native", DB_TYPE: "postgres", DB_PASSWORD: "" },
      "non-empty DB_PASSWORD",
    ],
    [
      {
        APP_MODE: "native",
        DB_TYPE: "postgres",
        DB_USER: "hotel_admin",
        DB_PASSWORD: secret,
        DB_HOST: "127.0.0.1",
        DB_PORT: "1",
      },
      "Database connection failed",
    ],
  ]) {
    await startupFails(values, expected);
    pass("Startup rejects " + expected);
  }
  await configure({ APP_MODE: "native", DB_TYPE: "embedded" });
  const embedded = await command(process.execPath, [
    "scripts/browser-smoke.mjs",
  ]);
  if (!embedded.output.includes('"result": "PASS"'))
    throw Error("Embedded browser smoke incomplete");
  pass(
    "Native embedded: SPA + REST + authenticated WebSocket on one port; restart/data/session persistence",
  );
  const pgEnv = "data/config-test-" + id + ".env";
  await writeFile(
    pgEnv,
    `POSTGRES_DB=config_validation_test\nPOSTGRES_USER=config_admin\nPOSTGRES_PASSWORD=${secret}\n`,
  );
  try {
    await command("docker", [
      "run",
      "-d",
      "--name",
      pgContainer,
      "--env-file",
      pgEnv,
      "-p",
      "127.0.0.1::5432",
      "postgres:17-alpine",
    ]);
    pgCreated = true;
  } finally {
    await rm(pgEnv, { force: true });
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const result = await command(
      "docker",
      [
        "exec",
        pgContainer,
        "pg_isready",
        "-U",
        "config_admin",
        "-d",
        "config_validation_test",
      ],
      {},
      true,
    );
    if (!result.code) {
      ready = true;
      break;
    }
    await delay(500);
  }
  if (!ready) throw Error("Isolated PostgreSQL did not become ready");
  const mapped = (
    await command("docker", ["port", pgContainer, "5432/tcp"])
  ).output
    .trim()
    .split(":")
    .pop();
  const pg = {
    APP_MODE: "native",
    NODE_ENV: "development",
    DB_TYPE: "postgres",
    DB_USER: "config_admin",
    DB_PASSWORD: secret,
    DB_NAME: "config_validation_test",
    DB_HOST: "127.0.0.1",
    DB_PORT: mapped,
    DB_SSL: "false",
    DEMO_SEED: "true",
    DEMO_PASSWORD: demoSecret,
  };
  await startupFails(
    { ...pg, DB_PASSWORD: secret + "wrong" },
    "Database authentication failed",
  );
  pass("Real PostgreSQL wrong password rejected without leaking secret");
  await configure(pg);
  const nativePg = await command(
    process.execPath,
    ["scripts/browser-smoke.mjs"],
    { SMOKE_EXTERNAL_DB: "true" },
  );
  if (!nativePg.output.includes('"result": "PASS"'))
    throw Error("Native PostgreSQL smoke incomplete");
  pass(
    "Native external PostgreSQL: one-port SPA/API/WebSocket; restart/data/session persistence; special-character password",
  );
  const dockerEnv = {
    ...pg,
    APP_MODE: "docker",
    DB_HOST: "ignored.example",
    DB_PORT: "12345",
  };
  await configure(dockerEnv);
  composeAttempted = true;
  console.log("Building and starting isolated Compose deployment...");
  await command("docker", [
    ...compose,
    "up",
    "--build",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
  ]);
  pass(
    "Docker build, configuration preflight, private PostgreSQL health and app health",
  );
  const image = (
    await command("docker", [...compose, "images", "-q", "app"])
  ).output.trim();
  await configure({ ...dockerEnv, APP_MODE: "native" });
  const mismatch = await command(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      resolve(".env") + ":/app/.env:ro",
      image,
      "node",
      "dist/server/validate-config.js",
    ],
    {},
    true,
  );
  if (
    !mismatch.code ||
    !mismatch.output.includes("does not match docker startup")
  )
    throw Error("Docker did not reject native APP_MODE");
  pass("Docker command rejects APP_MODE=native");
  await configure(dockerEnv);
  const override = await command(
    "docker",
    [
      "run",
      "--rm",
      "-e",
      "CHECK_DB_PASSWORD=different-shell-value",
      "-v",
      resolve(".env") + ":/app/.env:ro",
      image,
      "node",
      "dist/server/validate-config.js",
    ],
    {},
    true,
  );
  if (
    !override.code ||
    !override.output.includes("Compose interpolation differs")
  )
    throw Error("Compose credential mismatch was not rejected");
  pass(
    "Compose shell credential override rejected before database initialization",
  );
  const inspect = await command("docker", [...compose, "ps", "-q", "db"]);
  const ports = await command("docker", [
    "inspect",
    "--format",
    "{{json .HostConfig.PortBindings}}",
    inspect.output.trim(),
  ]);
  if (ports.output.trim() !== "{}" && ports.output.trim() !== "null")
    throw Error("Compose PostgreSQL exposed a host port");
  pass("Compose PostgreSQL has no published port");
  const dockerSmoke = await command(
    process.execPath,
    ["scripts/browser-smoke.mjs"],
    {
      SMOKE_DOCKER: "true",
      SMOKE_COMPOSE_PROJECT: project,
      SMOKE_PASSWORD: demoSecret,
    },
  ).catch(async error => {
    const logs = await command("docker", [...compose, "logs", "--no-color", "app"], {}, true);
    throw Error(error.message + "\nApplication logs:\n" + logs.output.slice(-6000));
  });
  if (!dockerSmoke.output.includes('"result": "PASS"'))
    throw Error("Docker smoke incomplete");
  pass(
    "Docker PostgreSQL: one-port SPA/API/WebSocket; restart/data/session persistence",
  );
  const fingerprintArgs = [
    ...compose,
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "config_admin",
    "-d",
    "config_validation_test",
    "-tAc",
    "SELECT md5(string_agg(id||status||coalesce(assignee,''), ',' ORDER BY id)) FROM tasks",
  ];
  const before = (await command("docker", fingerprintArgs)).output.trim();
  if (!before)
    throw Error("Missing persisted task data before database recreation");
  await command("docker", [...compose, "stop", "app"]);
  await command("docker", [
    ...compose,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
    "--force-recreate",
    "db",
  ]);
  await command("docker", [
    ...compose,
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "180",
    "app",
  ]);
  const after = (await command("docker", fingerprintArgs)).output.trim();
  if (before !== after)
    throw Error(
      "Database records changed after PostgreSQL container recreation",
    );
  pass(
    "PostgreSQL volume preserves task data after database container recreation",
  );
  const logs = await command("docker", [
    ...compose,
    "logs",
    "--no-color",
    "app",
  ]);
  if (!logs.output.includes("connection=ready"))
    throw Error("Missing startup connection status");
  pass("Startup status without secrets");
  // The host startup must reject Docker mode even when Docker is already running.
  await startupFails(dockerEnv, "does not match native startup");
  pass("Native command rejected while Docker mode selected");
  await startupFails(
    { ...pg, APP_PORT: "3001", APP_URL: "http://localhost:3001" },
    "Another deployment",
  );
  pass(
    "Shared lock rejects concurrent native startup while Docker runs, even on a different port",
  );
  await configure(dockerEnv);
} finally {
  if (composeAttempted)
    await command(
      "docker",
      [...compose, "down", "--volumes", "--remove-orphans"],
      {},
      true,
    );
  if (pgCreated) await command("docker", ["rm", "-f", pgContainer], {}, true);
  await writeFile(".env", original);
  await writeFile(
    "artifacts/config-deployment-result.json",
    JSON.stringify(report, null, 2),
  );
}
