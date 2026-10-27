import { loadConfig, applyConfig } from "./config.js";
import { acquireDeploymentLock } from "./deployment-lock.js";
import { openDb, migrate, sql, databaseError } from "./db.js";
import { buildApp } from "./app.js";
import { worker } from "./worker.js";
import { seed } from "./seed.js";
import { frontendPath } from "./paths.js";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";

async function main() {
  const config = loadConfig();
  if (!existsSync(join(frontendPath, "index.html")))
    throw Error(
      "Frontend build is missing. Run npm run build before npm start.",
    );
  applyConfig(config);
  const release = await acquireDeploymentLock();
  const db = await openDb(false, config).catch(async (error) => {
    await release();
    throw databaseError(error);
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closeHookRegistered = false;
  try {
    await db.checkConnection();
    await migrate(db);
    if (
      config.demoSeed &&
      !(await db.query(sql`SELECT 1 FROM users LIMIT 1`)).length
    ) {
      await seed(db, config.demoPassword!);
      console.log(
        "DEMO workspace initialized. Sample data; no live Oracle connection.",
      );
      console.log("DEMO login: admin@demo.local");
      console.log("Use the DEMO_PASSWORD configured in root .env.");
    }
    app = await buildApp(db);
    await app.register(staticFiles, { root: frontendPath });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0];
      if (
        path === "/api" ||
        path.startsWith("/api/") ||
        path === "/docs" ||
        path.startsWith("/docs/") ||
        path.startsWith("/assets/") ||
        !["GET", "HEAD"].includes(req.method)
      )
        return reply.code(404).send({ error: "Not found" });
      if (!req.headers.accept?.includes("text/html"))
        return reply.code(404).send({ error: "Not found" });
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    });
    const w = worker(db);
    let pending: Promise<void> | undefined;
    const lifecycle: { timer?: ReturnType<typeof setInterval> } = {};
    const run = () => {
      if (pending) return;
      pending = w
        .tick()
        .catch(() =>
          console.error(
            "Integration worker tick failed; inspect service health",
          ),
        )
        .finally(() => {
          pending = undefined;
        });
    };
    app.addHook("onClose", async () => {
      if (lifecycle.timer) clearInterval(lifecycle.timer);
      await pending;
      try {
        await db.close();
      } finally {
        await release();
      }
    });
    closeHookRegistered = true;
    await app.listen({ port: config.port, host: config.host });
    lifecycle.timer = setInterval(run, 5000);
    run();
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        void app!.close();
      });
    console.log(
      `${config.name}: ${config.origin} (mode=${config.mode}, database=${config.databaseType}, port=${config.port}, connection=ready)`,
    );
  } catch (error) {
    if (app) await app.close();
    if (!closeHookRegistered) {
      try {
        await db.close();
      } finally {
        await release();
      }
    }
    throw error;
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});
