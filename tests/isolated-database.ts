import { randomUUID } from "node:crypto";
import { openDb, sql } from "../apps/api/src/db";
// A PostgreSQL run must use an isolated schema in an explicitly local test database.
export async function isolatedDatabase() {
  const connection = process.env.TEST_DATABASE_URL;
  if (!connection) {
    const db = await openDb(true);
    return { db, close: () => db.close() };
  }
  const url = new URL(connection);
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.endsWith("_test")
  )
    throw Error(
      "TEST_DATABASE_URL must target a local database ending in _test",
    );
  const schema = "ocim_test_" + randomUUID().replaceAll("-", "");
  url.searchParams.set("options", "-csearch_path=" + schema);
  const db = await openDb(false, url.toString());
  await db.query(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
  return {
    db,
    async close() {
      try {
        await db.query(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
      } finally {
        await db.close();
      }
    },
  };
}
