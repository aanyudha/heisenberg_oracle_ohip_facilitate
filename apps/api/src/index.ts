import { loadConfig, applyConfig } from "./config.js";
import { acquireDeploymentLock } from "./deployment-lock.js";
import { openDb, migrate, sql, databaseError } from "./db.js";
import { buildApp } from "./app.js";
import { worker } from "./worker.js";
import { seed } from "./seed.js";
import { frontendPath } from "./paths.js";
import {
  integrationLabel,
  integrationSummary,
  printStartup,
  verifyFrontendBuild,
} from "./startup-report.js";
import { startTrafficMeter } from "./traffic.js";
import staticFiles from "@fastify/static";

async function main() {
  const config = loadConfig();
  const assets = await verifyFrontendBuild();
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
    const migration = await migrate(db);
    let integration = await integrationSummary(db);
    let nextIntegrationCheck = Date.now() + 30000;
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
    let stopMeter = () => {};
    let pending: Promise<void> | undefined;
    const lifecycle: { timer?: ReturnType<typeof setInterval> } = {};
    const run = () => {
      if (pending) return;
      pending = (async () => {
        await w.tick();
        if (Date.now() >= nextIntegrationCheck) {
          integration = await integrationSummary(db);
          nextIntegrationCheck = Date.now() + 30000;
        }
      })()
        .catch(() =>
          console.error(
            "Integration worker tick failed; inspect service health",
          ),
        )
        .finally(() => {
          pending = undefined;
        });
    };
    app.addHook("preClose", async () => {
      stopMeter();
      if (lifecycle.timer) clearInterval(lifecycle.timer);
      await pending;
    });
    app.addHook("onClose", async () => {
      try {
        await db.close();
      } finally {
        await release();
      }
    });
    closeHookRegistered = true;
    try {
      await app.listen({ port: config.port, host: config.host });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE")
        throw Error(
          `Cannot listen on ${config.host}:${config.port}: address is already in use. Stop the owning application or choose an unused APP_PORT.`,
        );
      if (code === "EADDRNOTAVAIL")
        throw Error(
          `Cannot bind APP_HOST=${config.host}: this IP is not assigned to this computer. Set APP_HOST to a local interface IP (or explicitly 0.0.0.0). APP_URL remains the browser URL.`,
        );
      throw error;
    }
    printStartup(config, migration, integration, assets);
    stopMeter = startTrafficMeter(config, undefined, () =>
      integrationLabel(integration),
    );
    lifecycle.timer = setInterval(run, 5000);
    run();
    let closing: Promise<void> | undefined;
    const shutdown = () => {
      closing ||= app!
        .close()
        .catch(() => {
          console.error("Shutdown failed; inspect service health.");
          process.exitCode = 1;
        })
        .finally(() => {
          if (process.connected) process.disconnect();
        });
    };
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
    // IPC supports graceful disposable Windows child tests without fake SIGINT.
    if (process.send)
      process.on("message", (message) => {
        if (message === "shutdown") {
          shutdown();
        }
      });
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
