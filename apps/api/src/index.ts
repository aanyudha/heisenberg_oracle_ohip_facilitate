import { loadConfig } from "./config.js";
import { openDb, migrate, sql } from "./db.js";
import { buildApp } from "./app.js";
import { worker } from "./worker.js";
import { seed } from "./seed.js";
import { frontendPath } from "./paths.js";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

async function main() {
  const config = loadConfig();
  if (!existsSync(join(frontendPath, "index.html")))
    throw Error(
      "Frontend build is missing. Run npm run build before npm start.",
    );
  process.env.APP_ORIGIN = config.origin;
  process.env.APP_MODE = config.mode;
  process.env.COOKIE_SECURE = config.cookieSecure;
  process.env.LOCAL_DB_PATH = config.databasePath;
  const db = await openDb(false, config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await migrate(db);
    if (
      config.mode === "demo" &&
      !(await db.query(sql`SELECT 1 FROM users LIMIT 1`)).length
    ) {
      const password =
        config.demoPassword || randomBytes(18).toString("base64url");
      await seed(db, password);
      console.log(
        "DEMO workspace initialized. Sample data; no live Oracle connection.",
      );
      console.log("DEMO login: admin@demo.local");
      console.log("DEMO initial password:", password);
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
      await db.close();
    });
    await app.listen({ port: config.port, host: config.host });
    lifecycle.timer = setInterval(run, 5000);
    run();
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        void app!.close();
      });
    console.log(
      `Hospitality Operations: ${config.origin} (${config.mode}, ${config.databaseUrl ? "PostgreSQL" : "persistent embedded database"})`,
    );
  } catch (error) {
    if (app) await app.close();
    else await db.close();
    throw error;
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});
