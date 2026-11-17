import { PGlite } from "@electric-sql/pglite";
import { drizzle as embedded } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { loadConfig, type AppConfig } from "./config.js";
import { sql, type SQL } from "drizzle-orm";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireDeploymentLock } from "./deployment-lock.js";
export { migrate } from "./startup-migrations.js";
export { sql };
export type Database = Awaited<ReturnType<typeof openDb>>;
export async function openDb(test = false, connection?: string | AppConfig) {
  const config =
    !test && typeof connection !== "string"
      ? connection || loadConfig()
      : undefined;
  const postgres: PoolConfig | undefined =
    typeof connection === "string"
      ? { connectionString: connection, connectionTimeoutMillis: 5000 }
      : config?.database;
  if (config && !postgres) {
    const info = await stat(config.databasePath).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return undefined;
      },
    );
    if (info && !info.isDirectory())
      throw Error("Embedded DB_FILE must be a directory, not a file.");
    if (!info && config.production)
      throw Error(
        "Configured embedded database is missing. Refusing to create a replacement production database; restore the configured directory or provision it explicitly in development.",
      );
    if (info && (await readdir(config.databasePath)).length) {
      const version = await readFile(
        join(config.databasePath, "PG_VERSION"),
        "utf8",
      ).catch(() => "");
      if (!/^\d+\s*$/.test(version))
        throw Error(
          "Configured embedded database directory is not a valid PGlite/PostgreSQL data directory. Restore it; no replacement database was created.",
        );
    }
    if (
      info &&
      config.production &&
      !(await readdir(config.databasePath)).length
    )
      throw Error(
        "Configured production embedded database directory is empty; refusing replacement initialization.",
      );
  }
  // Embedded PostgreSQL has no separate server to arbitrate file ownership.
  // A lease next to the canonical data directory protects cross-checkout starts
  // too, without placing lock files inside the recoverable database archive.
  const releaseEmbedded =
    config && !postgres
      ? await acquireDeploymentLock(
          (await realpath(config.databasePath).catch(
            () => config.databasePath,
          )) + ".runtime-lock",
        )
      : async () => {};
  let client: PGlite | Pool;
  try {
    client =
      test || !postgres
        ? new PGlite(test ? undefined : config!.databasePath)
        : new Pool(postgres);
    if (client instanceof PGlite) await client.waitReady;
  } catch (error) {
    await releaseEmbedded();
    throw error;
  }
  const orm = client instanceof PGlite ? embedded(client) : drizzle(client);
  let closed = false;
  return {
    orm,
    async backupBeforeMigration() {
      if (!(client instanceof PGlite) || test) return undefined;
      // PGlite exports through its own synchronized checkpoint/archive API.
      // Never copy live PostgreSQL files from the filesystem.
      const directory = join(
        dirname(config!.databasePath),
        "migration-backups",
      );
      await mkdir(directory, { recursive: true });
      const path = join(
        directory,
        `pre-migration-${Date.now()}-${randomUUID()}.tar.gz`,
      );
      const archive = await client.dumpDataDir("gzip");
      await writeFile(path, Buffer.from(await archive.arrayBuffer()), {
        flag: "wx",
        mode: 0o600,
      });
      if (!(await stat(path)).size)
        throw Error("Embedded pre-migration backup is empty; startup stopped.");
      return path;
    },
    async checkConnection() {
      try {
        await orm.execute(sql`SELECT 1`);
      } catch (error) {
        throw databaseError(error);
      }
    },
    async query<T = Record<string, any>>(query: SQL): Promise<T[]> {
      return (await orm.execute(query)).rows as T[];
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (client instanceof PGlite) await client.close();
        else await client.end();
      } finally {
        await releaseEmbedded();
      }
    },
  };
}
export function databaseError(error: unknown): Error {
  const e = error as { code?: string; cause?: { code?: string } };
  const code = e?.code || e?.cause?.code;
  if (
    error instanceof Error &&
    /^(Configured |Embedded DB_FILE|Another deployment |Cannot create deployment lock)/.test(
      error.message,
    )
  )
    return error;
  if (code === "28P01" || code === "28000")
    return Error(
      "Database authentication failed. Check DB_USER and DB_PASSWORD in root .env; an existing PostgreSQL volume retains its original credentials.",
    );
  if (code === "3D000")
    return Error(
      "Database does not exist. Check DB_NAME and provision the PostgreSQL database.",
    );
  return Error(
    `Database connection failed${code && /^[A-Z0-9_]{2,40}$/.test(code) ? ` (${code})` : ""}. Check DB_HOST, DB_PORT, DB_SSL, database service availability and data directory permissions.`,
  );
}
