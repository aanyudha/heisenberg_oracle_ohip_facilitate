import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { migrationPath } from "./paths.js";
import { migrateLegacyConnections } from "./connection-store.js";
import {
  historicalChecksums,
  migrationStatements,
  validateMigration,
} from "./migration-policy.js";

export type MigrationReport = {
  previous: string;
  current: string;
  pending: string[];
  applied: number;
  status: "SUCCESS" | "UP TO DATE";
  duration: number;
  backup?: string;
  legacyBaselines: number;
};
const queues = new WeakMap<Database, Promise<unknown>>();
export function migrate(
  db: Database,
  directory = migrationPath,
): Promise<MigrationReport> {
  const previous = queues.get(db) || Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(() => runMigrations(db, directory));
  queues.set(db, work);
  return work;
}
async function runMigrations(
  db: Database,
  directory: string,
): Promise<MigrationReport> {
  const started = Date.now();
  const files = (await readdir(directory))
    .filter((n) => /^\d{4}_[a-z0-9_]+\.sql$/.test(n))
    .sort();
  if (!files.length || files[0].slice(0, 4) !== "0001")
    throw Error(
      "Migration bundle is missing initial schema; rebuild before startup.",
    );
  const migrations = await Promise.all(
    files.map(async (name) => {
      const body = await readFile(join(directory, name), "utf8");
      return {
        name,
        body,
        version: name.slice(0, 4),
        digest: validateMigration(name, body),
      };
    }),
  );
  if (new Set(migrations.map((m) => m.version)).size !== migrations.length)
    throw Error("Duplicate migration versions; startup stopped.");
  if (migrations.some((m, i) => Number(m.version) !== i + 1))
    throw Error(
      "Migration bundle has a version gap; restore the complete bundle before startup.",
    );
  // Detect a required snapshot before opening the migration transaction. PGlite's
  // archive API must run outside a user transaction. Native startup/CLI hold the
  // shared deployment lock; PostgreSQL additionally uses its DB advisory lock below.
  const exists = (
    await db.query(sql`SELECT to_regclass('schema_migrations') AS name`)
  )[0].name;
  const appliedBefore = exists
    ? await db.query<{ version: string }>(
        sql`SELECT version FROM schema_migrations ORDER BY version`,
      )
    : [];
  const metadataExists = (
    await db.query(sql`SELECT to_regclass('schema_migration_metadata') AS name`)
  )[0].name;
  const backup =
    migrations.some(
      (m) => !appliedBefore.some((a) => a.version === m.version),
    ) || !metadataExists
      ? await db.backupBeforeMigration()
      : undefined;
  let activeMigration: string | null = null;
  try {
    return await db.orm.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '15s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(7291043000::bigint)`);
      const permission = (
        await tx.execute(
          sql`SELECT has_schema_privilege(current_user,current_schema(),'USAGE') AND has_schema_privilege(current_user,current_schema(),'CREATE') AS allowed`,
        )
      ).rows[0] as { allowed: boolean };
      if (!permission.allowed)
        throw Error(
          "Database role requires USAGE and CREATE on the application schema; startup stopped.",
        );
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS schema_migration_attempts (
      id bigserial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
      execution_result text NOT NULL, duration_ms integer NOT NULL,
      migration_name text)`);
      await tx.execute(
        sql`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY)`,
      );
      // Companion metadata preserves all legacy version rows without rewriting history.
      await tx.execute(sql`CREATE TABLE IF NOT EXISTS schema_migration_metadata (
      version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now(),
      execution_result text NOT NULL, duration_ms integer,
      legacy_baseline boolean NOT NULL DEFAULT false)`);
      const history = (
        await tx.execute(
          sql`SELECT h.version,m.name,m.checksum FROM schema_migrations h LEFT JOIN schema_migration_metadata m USING(version) ORDER BY h.version`,
        )
      ).rows as {
        version: string;
        name: string | null;
        checksum: string | null;
      }[];
      for (let i = 0; i < history.length; i++) {
        const h = history[i],
          m = migrations[i];
        if (!m || m.version !== h.version)
          throw Error(
            `Unknown or noncontiguous migration history at ${h.version}; startup stopped.`,
          );
        if (h.checksum && (h.checksum !== m.digest || h.name !== m.name))
          throw Error(`Applied migration checksum mismatch: ${m.name}`);
        if (!h.checksum && !historicalChecksums[m.name])
          throw Error(
            `Unverifiable legacy migration: ${m.name}; explicit administrator review required.`,
          );
      }
      const pending = migrations.slice(history.length);
      let legacyBaselines = 0;
      for (const h of history.filter((h) => !h.checksum)) {
        const m = migrations.find((m) => m.version === h.version)!;
        await tx.execute(
          sql`INSERT INTO schema_migration_metadata(version,name,checksum,execution_result,legacy_baseline) VALUES (${m.version},${m.name},${m.digest},'LEGACY BASELINE',true)`,
        );
        legacyBaselines++;
      }
      for (const m of pending) {
        activeMigration = m.name;
        const began = Date.now();
        try {
          for (const statement of migrationStatements(m.body))
            await tx.execute(sql.raw(statement));
          if (m.version === "0002") await migrateLegacyConnections(tx);
          await tx.execute(
            sql`INSERT INTO schema_migrations(version) VALUES (${m.version})`,
          );
          await tx.execute(
            sql`INSERT INTO schema_migration_metadata(version,name,checksum,applied_at,execution_result,duration_ms) VALUES (${m.version},${m.name},${m.digest},now(),'SUCCESS',${Date.now() - began})`,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith(
              "Cannot migrate existing OHIP credentials.",
            )
          )
            throw error;
          const e = error as { code?: string; cause?: { code?: string } };
          const code = e.code || e.cause?.code;
          throw Error(
            `Migration ${m.name} FAILED${code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""}; all pending changes rolled back. Check schema privileges and the original ENCRYPTION_KEY. No HTTP listener started.`,
          );
        }
      }
      // Resolve required columns against PostgreSQL's catalog before opening HTTP.
      await tx.execute(
        sql`SELECT u.id,s.csrf,c.last_sync,p.paused,p.control_revision,h.active FROM users u LEFT JOIN sessions s ON false LEFT JOIN connections c ON false LEFT JOIN ohip_connection_properties p ON false LEFT JOIN housekeeping_shifts h ON false LIMIT 0`,
      );
      const columns = (
        await tx.execute(
          sql`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema()`,
        )
      ).rows as { table_name: string; column_name: string }[];
      const present = new Set(
        columns.map((c) => `${c.table_name}.${c.column_name}`),
      );
      for (const m of migrations)
        for (const statement of migrationStatements(m.body)) {
          const create = /^CREATE TABLE\s+(\w+)\s*\(([\s\S]*)\)$/i.exec(
            statement,
          );
          const add = /^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(
            statement,
          );
          if (add && !present.has(`${add[1]}.${add[2]}`))
            throw Error(
              `Schema readiness failed: missing ${add[1]}.${add[2]}. Restore schema before startup.`,
            );
          if (create) {
            let depth = 0,
              quoted = false,
              start = 0;
            const definitions: string[] = [];
            for (let i = 0; i < create[2].length; i++) {
              const char = create[2][i];
              if (char === "'") quoted = !quoted;
              if (!quoted) {
                if (char === "(") depth++;
                if (char === ")") depth--;
                if (char === "," && depth === 0) {
                  definitions.push(create[2].slice(start, i));
                  start = i + 1;
                }
              }
            }
            definitions.push(create[2].slice(start));
            for (const definition of definitions) {
              const column = /^\s*(\w+)\s+/.exec(definition)?.[1];
              if (
                column &&
                !/^(FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT)$/i.test(column) &&
                !present.has(`${create[1]}.${column}`)
              )
                throw Error(
                  `Schema readiness failed: missing ${create[1]}.${column}. Restore schema before startup.`,
                );
            }
          }
        }
      if (pending.length || legacyBaselines)
        await tx.execute(
          sql`INSERT INTO schema_migration_attempts(execution_result,duration_ms,migration_name) VALUES ('SUCCESS',${Date.now() - started},${activeMigration})`,
        );
      return {
        previous: history.at(-1)?.version || "none",
        current: migrations.at(-1)!.version,
        pending: pending.map((m) => m.version),
        applied: pending.length,
        status: pending.length ? "SUCCESS" : "UP TO DATE",
        duration: Date.now() - started,
        backup,
        legacyBaselines,
      };
    });
  } catch (error) {
    // Record only bounded status/name after rollback; never driver SQL, payloads,
    // credentials or guest records. Connection loss may prevent this audit write.
    await db
      .query(
        sql`INSERT INTO schema_migration_attempts(execution_result,duration_ms,migration_name) VALUES ('FAILED / ROLLED BACK',${Date.now() - started},${activeMigration})`,
      )
      .catch(() => {});
    throw error;
  }
}
