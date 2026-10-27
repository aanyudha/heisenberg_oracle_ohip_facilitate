import { spawn } from "node:child_process";
// Demo bootstrap is selected explicitly in root .env (DEMO_SEED=true).
const child = spawn(process.execPath, ["dist/server/index.js"], {
  stdio: "inherit",
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
