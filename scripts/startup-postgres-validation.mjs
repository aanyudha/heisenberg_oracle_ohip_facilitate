import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
const name = `startup-pg-test-${randomBytes(5).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const image = "postgres:17-alpine";
const run = (args, options = {}) =>
  spawnSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    ...options,
  });
if (run(["image", "inspect", image]).status !== 0)
  throw Error("Local PostgreSQL test image unavailable; no image was pulled.");
let created = false;
await mkdir("artifacts/startup", { recursive: true });
try {
  const start = run([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `startup-validation=${name}`,
    "-e",
    "POSTGRES_DB=startup_test",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-p",
    "127.0.0.1::5432",
    image,
  ]);
  if (start.status !== 0)
    throw Error("Could not create disposable PostgreSQL container");
  created = true;
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (
      run(["exec", name, "pg_isready", "-U", "postgres", "-d", "startup_test"])
        .status === 0
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw Error("Disposable PostgreSQL did not become ready");
  const portResult = run(["port", name, "5432/tcp"]);
  const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(portResult.stdout)?.[1];
  if (!port) throw Error("Disposable PostgreSQL port mapping invalid");
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "tests/startup-migrations.test.ts",
      "tests/connection-migration.test.ts",
      "tests/connections.test.ts",
      "--reporter=verbose",
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/startup_test`,
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 180000,
    },
  );
  const output = (result.stdout || "") + (result.stderr || "");
  if (output.includes(password))
    throw Error("Secret detected in test output; output withheld");
  await writeFile("artifacts/startup/postgres-tests.txt", output);
  console.log(output);
  if (result.status !== 0)
    throw Error(
      "Disposable PostgreSQL tests failed; see artifacts/startup/postgres-tests.txt",
    );
} finally {
  if (created) {
    const label = run([
      "inspect",
      "--format",
      '{{index .Config.Labels "startup-validation"}}',
      name,
    ]);
    if (label.stdout.trim() !== name) {
      console.error("Container ownership check failed; cleanup stopped");
      process.exitCode = 1;
    } else {
      const removal = run(["rm", "-f", "-v", name]);
      if (removal.status !== 0) {
        console.error("Disposable container cleanup failed");
        process.exitCode = 1;
      }
    }
  }
}
