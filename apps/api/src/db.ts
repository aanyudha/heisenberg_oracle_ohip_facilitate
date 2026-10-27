import "dotenv/config";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as embedded } from "drizzle-orm/pglite";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql, type SQL } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrationPath } from "./paths.js";
export { sql };
export type Database = Awaited<ReturnType<typeof openDb>>;
export async function openDb(
  test = false,
  connectionString = process.env.DATABASE_URL,
) {
  if (
    !test &&
    !connectionString &&
    (process.env.LOCAL_DEMO === "false" ||
      process.env.NODE_ENV === "production" ||
      process.env.APP_MODE === "server")
  )
    throw Error("Server mode requires DATABASE_URL");
  const client =
    test || !connectionString
      ? new PGlite(
          test ? undefined : process.env.LOCAL_DB_PATH || "./data/demo",
        )
      : new Pool({ connectionString });
  const orm = client instanceof PGlite ? embedded(client) : drizzle(client);
  return {
    orm,
    async query<T = Record<string, any>>(query: SQL): Promise<T[]> {
      return (await orm.execute(query)).rows as T[];
    },
    async close() {
      if (client instanceof PGlite) await client.close();
      else await client.end();
    },
  };
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
