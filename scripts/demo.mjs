import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
if (!existsSync("dist/server/index.js"))
  throw Error("Run npm run build before npm run demo");
const child = spawn(process.execPath, ["dist/server/index.js"], {
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    APP_MODE: "demo",
    DATABASE_URL: "",
    LOCAL_DEMO: "true",
  },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
