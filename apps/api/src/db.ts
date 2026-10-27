import { PGlite } from "@electric-sql/pglite";
import { drizzle as embedded } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { loadConfig, type AppConfig } from "./config.js";
import { sql, type SQL } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrationPath } from "./paths.js";
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
  const client =
    test || !postgres
      ? new PGlite(test ? undefined : config!.databasePath)
      : new Pool(postgres);
  const orm = client instanceof PGlite ? embedded(client) : drizzle(client);
  return {
    orm,
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
      if (client instanceof PGlite) await client.close();
      else await client.end();
    },
  };
}
export function databaseError(error: unknown): Error {
  const e = error as { code?: string; cause?: { code?: string } };
  const code = e?.code || e?.cause?.code;
  if (code === "28P01" || code === "28000")
    return Error(
      "Database authentication failed. Check DB_USER and DB_PASSWORD in root .env; an existing PostgreSQL volume retains its original credentials.",
    );
  if (code === "3D000")
    return Error(
      "Database does not exist. Check DB_NAME and provision the PostgreSQL database.",
    );
  return Error(
    "Database connection failed. Check DB_HOST, DB_PORT, DB_SSL, database service availability and data directory permissions.",
  );
}
export async function migrate(db: Database) {
  const migration = await readFile(
    join(migrationPath, "0001_initial.sql"),
    "utf8",
  );
  await db.orm.transaction(async (tx) => {
    // Also serialize the very first CREATE TABLE across concurrent processes.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7291043000::bigint)`);
    await tx.execute(
      sql`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)`,
    );
    if (
      (
        await tx.execute(
          sql`SELECT version FROM schema_migrations WHERE version='0001'`,
        )
      ).rows.length
    )
      return;
    for (const statement of migration.split(";").filter((s) => s.trim()))
      await tx.execute(sql.raw(statement));
    await tx.execute(sql`INSERT INTO schema_migrations VALUES ('0001')`);
  });
}
