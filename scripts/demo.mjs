import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
// Password stays in child environment and terminal output, never in tracked files.
const password =
  process.env.DEMO_PASSWORD || randomBytes(18).toString("base64url");
const env = {
  ...process.env,
  DATABASE_URL: "",
  LOCAL_DEMO: "true",
  LOCAL_DB_PATH: process.env.LOCAL_DB_PATH || "./data/demo",
  DEMO_PASSWORD: password,
  APP_ORIGIN: "http://localhost:5173",
};
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(Error("Demo setup failed")),
    );
    child.on("error", reject);
  });
}
await run(["--import", "tsx", "apps/api/src/migrate.ts"]);
await run(["--import", "tsx", "apps/api/src/seed.ts"]);
console.log("DEMO login: admin@demo.local");
console.log("Password for a newly seeded database:", password);
console.log(
  "Existing demo users keep their original passwords. Use DEMO_PASSWORD consistently.",
);
const child = spawn(
  process.execPath,
  [
    "node_modules/concurrently/dist/bin/concurrently.js",
    "-k",
    "npm run dev -w apps/api",
    "npm run dev -w apps/web",
  ],
  { stdio: "inherit", env },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
