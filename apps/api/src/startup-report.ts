import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { sql, type Database } from "./db.js";
import type { AppConfig } from "./config.js";
import type { MigrationReport } from "./startup-migrations.js";
import { frontendPath } from "./paths.js";
import { version } from "../../../package.json";

export async function verifyFrontendBuild(directory = frontendPath) {
  let html: string;
  try {
    html = await readFile(resolve(directory, "index.html"), "utf8");
  } catch {
    throw Error(
      "Frontend build is missing. Run npm run build before npm start.",
    );
  }
  const assets = [
    ...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g),
  ].map((m) => m[1]);
  // Vite's manifest covers bootstrap, dynamic React chunks, lazy routes and CSS.
  // Directory enumeration alone cannot detect a deleted lazy chunk.
  let manifest: Record<
    string,
    { file: string; css?: string[]; assets?: string[] }
  >;
  try {
    manifest = JSON.parse(
      await readFile(resolve(directory, ".vite/manifest.json"), "utf8"),
    );
  } catch {
    throw Error(
      "Frontend build manifest is missing or invalid. Run npm run build.",
    );
  }
  for (const chunk of Object.values(manifest))
    for (const file of [
      chunk.file,
      ...(chunk.css || []),
      ...(chunk.assets || []),
    ]) {
      if (typeof file !== "string" || !file.startsWith("assets/"))
        throw Error(
          "Frontend manifest contains an invalid asset path. Rebuild before startup.",
        );
      if (!assets.includes("/" + file)) assets.push("/" + file);
    }
  if (
    !assets.some((a) => a.endsWith(".js")) ||
    !assets.some((a) => a.endsWith(".css"))
  )
    throw Error(
      "Frontend build has no compiled JS/CSS assets. Run npm run build.",
    );
  for (const asset of assets) {
    const path = resolve(directory, "." + asset);
    if (
      !path.startsWith(resolve(directory) + sep) ||
      !(await stat(path).catch(() => undefined))?.isFile()
    )
      throw Error(
        "Frontend asset is missing or invalid. Run npm run build before npm start.",
      );
  }
  return assets.length;
}
export async function integrationSummary(db: Database) {
  const row = (
    await db.query(sql`SELECT
    (SELECT count(*)::int FROM ohip_connections WHERE archived_at IS NULL) AS configured,
    (SELECT count(*)::int FROM ohip_connection_properties p JOIN ohip_connections o ON o.tenant_id=p.tenant_id AND o.id=p.connection_id WHERE o.archived_at IS NULL AND (o.paused OR p.paused)) AS paused,
    (SELECT count(*)::int FROM ohip_connection_properties p JOIN ohip_connections o ON o.tenant_id=p.tenant_id AND o.id=p.connection_id WHERE o.archived_at IS NULL AND NOT o.paused AND NOT p.paused AND p.validation_status='validated') AS running,
    (SELECT max(last_sync) FROM connections WHERE mode='real') AS last_sync`)
  )[0];
  return {
    configured: Number(row.configured),
    paused: Number(row.paused),
    running: Number(row.running),
    lastSync: row.last_sync ? new Date(row.last_sync).toISOString() : null,
  };
}
export type IntegrationSummary = Awaited<ReturnType<typeof integrationSummary>>;
export const integrationLabel = (s: IntegrationSummary) =>
  `configured ${s.configured} | polling eligible ${s.running} | paused ${s.paused} (not live health)`;
export function printStartup(
  config: AppConfig,
  migration: MigrationReport,
  integration: IntegrationSummary,
  assets: number,
) {
  const report = {
    event: "application_ready",
    application: {
      mode: config.mode,
      environment: config.runtimeEnvironment,
      version,
    },
    database: {
      engine:
        config.databaseType === "embedded"
          ? "PostgreSQL / PGlite"
          : "PostgreSQL",
      connection:
        config.databaseType === "embedded"
          ? "embedded persistent"
          : config.mode === "docker"
            ? "Docker service"
            : "external",
      ready: true,
      migration,
    },
    network: {
      bind: config.host,
      port: config.port,
      url: config.origin,
      http: "listening",
      websocket: "listener ready; client connection not implied",
      frontend: `${assets} compiled asset references verified; React render not verified by server`,
    },
    integration: {
      policy: "OHIP STRICT READ ONLY",
      ...integration,
      health:
        "configuration and stored sync only; live connectivity not asserted",
    },
  };
  if (
    !process.stdout.isTTY ||
    config.mode === "docker" ||
    config.startupDashboard === "off"
  ) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(
    [
      "",
      "APPLICATION",
      `  Mode         : ${config.mode === "native" ? "Native" : "Docker"}`,
      `  Environment  : ${config.runtimeEnvironment}`,
      `  Version      : ${version}`,
      "DATABASE MIGRATION",
      `  Engine       : ${report.database.engine} (${report.database.connection})`,
      `  Previous     : ${migration.previous}`,
      `  Current      : ${migration.current}`,
      `  Pending      : ${migration.pending.join(", ") || "0"}`,
      `  Result       : ${migration.status}`,
      `  Applied      : ${migration.applied}`,
      `  Duration     : ${migration.duration} ms`,
      `  Legacy       : ${migration.legacyBaselines} baselines (original timestamps unknown)`,
      ...(migration.backup ? [`  Backup       : ${migration.backup}`] : []),
      "  Connection   : ready; schema verified",
      "NETWORK",
      `  Bind         : ${config.host}:${config.port}`,
      `  APP_URL      : ${config.origin}`,
      "  HTTP         : listening",
      "  WebSocket    : listener ready; no client implied",
      `  Frontend     : ${assets} assets verified; browser render requires browser acceptance`,
      "INTEGRATION",
      "  Policy       : OHIP STRICT READ ONLY",
      `  State        : ${integrationLabel(integration)}`,
      `  Last sync    : ${integration.lastSync || "none recorded"}`,
      "",
    ].join("\n"),
  );
}
