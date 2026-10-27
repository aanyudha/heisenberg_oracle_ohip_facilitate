import { openDb, migrate } from "./db.js";
import { buildApp } from "./app.js";
import { worker } from "./worker.js";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (
  process.env.NODE_ENV === "production" &&
  (process.env.LOCAL_DEMO === "true" ||
    process.env.COOKIE_SECURE !== "true" ||
    !process.env.APP_ORIGIN?.startsWith("https://"))
)
  throw Error(
    "Production requires PostgreSQL, secure cookies, and HTTPS APP_ORIGIN",
  );
const db = await openDb();
await migrate(db);
const app = await buildApp(db);
const root = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(root)) {
  await app.register(staticFiles, { root });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/")
      ? reply.code(404).send({ error: "Not found" })
      : reply.sendFile("index.html"),
  );
}
const w = worker(db);
let pending: Promise<void> | undefined;
const run = () => {
  if (pending) return;
  pending = w
    .tick()
    .catch(() =>
      console.error("Integration worker tick failed; inspect service health"),
    )
    .finally(() => {
      pending = undefined;
    });
};
const timer = setInterval(run, 5000);
run();
app.addHook("onClose", async () => {
  clearInterval(timer);
  await pending;
  await db.close();
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => app.close());
await app.listen({
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || "127.0.0.1",
});
console.log(
  `Hospitality Operations listening on port ${Number(process.env.PORT) || 3001}`,
);
