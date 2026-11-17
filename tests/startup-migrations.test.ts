import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { isolatedDatabase } from "./isolated-database";
import { migrate, openDb, sql } from "../apps/api/src/db";
import { loadConfig } from "../apps/api/src/config";
import { migrationPath } from "../apps/api/src/paths";
import { validateMigration } from "../apps/api/src/migration-policy";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "startup-migrations-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const migrations = join(dir, "migrations");
  await cp(migrationPath, migrations, { recursive: true });
  const isolated = await isolatedDatabase();
  cleanup.push(isolated.close);
  return { db: isolated.db, migrations, dir };
}
describe("shared automatic migration workflow", () => {
  it("initializes an empty disposable database and stores checksums, results, timestamps and durations", async () => {
    const { db, migrations } = await fixture();
    expect(await migrate(db, migrations)).toMatchObject({
      previous: "none",
      current: "0006",
      applied: 6,
      status: "SUCCESS",
    });
    const rows = await db.query(
      sql`SELECT * FROM schema_migration_metadata ORDER BY version`,
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(r.execution_result).toBe("SUCCESS");
      expect(r.applied_at).toBeTruthy();
      expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(await migrate(db, migrations)).toMatchObject({
      applied: 0,
      status: "UP TO DATE",
    });
  });
  it("preserves populated records through one and multiple pending additive migrations and concurrent retries", async () => {
    const { db, migrations } = await fixture();
    await migrate(db, migrations);
    await db.query(
      sql`INSERT INTO tenants VALUES ('preserve','Existing tenant')`,
    );
    await writeFile(
      join(migrations, "0007_test_column.sql"),
      "ALTER TABLE tenants ADD COLUMN startup_note text;",
    );
    expect(await migrate(db, migrations)).toMatchObject({
      applied: 1,
      pending: ["0007"],
    });
    await writeFile(
      join(migrations, "0008_test_table.sql"),
      "CREATE TABLE startup_test (id text PRIMARY KEY, note text);",
    );
    await writeFile(
      join(migrations, "0009_test_index.sql"),
      "CREATE INDEX startup_test_note ON startup_test (note);",
    );
    const reports = await Promise.all([
      migrate(db, migrations),
      migrate({ ...db }, migrations),
    ]);
    expect(reports.map((r) => r.applied).sort()).toEqual([0, 2]);
    expect(
      await db.query(
        sql`SELECT name,startup_note FROM tenants WHERE id='preserve'`,
      ),
    ).toEqual([{ name: "Existing tenant", startup_note: null }]);
    expect(await migrate(db, migrations)).toMatchObject({
      applied: 0,
      current: "0009",
    });
  });
  it("fails closed for altered historical files and altered recorded checksums", async () => {
    const { db, migrations } = await fixture();
    await migrate(db, migrations);
    const path = join(migrations, "0004_housekeeping.sql");
    const original = await readFile(path, "utf8");
    await writeFile(path, original + "\n-- modified historical file\n");
    await expect(migrate(db, migrations)).rejects.toThrow(
      "Historical migration checksum mismatch",
    );
    await writeFile(path, original);
    await db.query(
      sql`UPDATE schema_migration_metadata SET checksum='bad' WHERE version='0005'`,
    );
    await expect(migrate(db, migrations)).rejects.toThrow(
      "Applied migration checksum mismatch",
    );
  });
  it("keeps legacy version rows and records explicit baselines with unknown original timestamps", async () => {
    const { db, migrations } = await fixture();
    await migrate(db, migrations);
    await db.query(sql`DROP TABLE schema_migration_metadata`);
    expect(await migrate(db, migrations)).toMatchObject({
      legacyBaselines: 6,
      applied: 0,
    });
    expect(
      await db.query(
        sql`SELECT * FROM schema_migration_metadata WHERE legacy_baseline AND applied_at IS NULL AND execution_result='LEGACY BASELINE'`,
      ),
    ).toHaveLength(6);
    expect(
      await db.query(
        sql`SELECT version FROM schema_migrations ORDER BY version`,
      ),
    ).toHaveLength(6);
  });
  it("rolls back all pending SQL and history on failure and retries safely", async () => {
    const { db, migrations } = await fixture();
    await migrate(db, migrations);
    await writeFile(
      join(migrations, "0007_test_column.sql"),
      "ALTER TABLE tenants ADD COLUMN startup_note text;",
    );
    await writeFile(
      join(migrations, "0008_test_failure.sql"),
      "ALTER TABLE nonexistent_table ADD COLUMN note text;",
    );
    await expect(migrate(db, migrations)).rejects.toThrow("FAILED");
    expect(
      await db.query(
        sql`SELECT version FROM schema_migrations WHERE version>'0006'`,
      ),
    ).toEqual([]);
    expect(
      await db.query(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name='tenants' AND column_name='startup_note' AND table_schema=current_schema()`,
      ),
    ).toEqual([]);
    await writeFile(
      join(migrations, "0008_test_failure.sql"),
      "ALTER TABLE tenants ADD COLUMN startup_second text;",
    );
    expect(await migrate(db, migrations)).toMatchObject({ applied: 2 });
  });
  it("blocks destructive, procedural and high-risk future SQL before applying any pending work", async () => {
    const { db, migrations } = await fixture();
    await migrate(db, migrations);
    for (const statement of [
      "DROP TABLE tenants;",
      "TRUNCATE tenants;",
      "DELETE FROM tenants;",
      "ALTER TABLE tenants ADD COLUMN test text NOT NULL;",
      "CREATE UNIQUE INDEX unsafe ON tenants(name);",
      "CREATE TABLE unsafe (id text DEFAULT dangerous_function());",
      "DO $$ BEGIN END $$;",
    ]) {
      expect(() => validateMigration("0007_test.sql", statement)).toThrow();
    }
    await writeFile(join(migrations, "0007_test.sql"), "DROP TABLE tenants;");
    await expect(migrate(db, migrations)).rejects.toThrow("blocked");
    expect(
      (await db.query(sql`SELECT count(*)::int AS n FROM schema_migrations`))[0]
        .n,
    ).toBe(6);
  });
  it("refuses incompatible schemas even with an up-to-date migration history", async () => {
    const { db, migrations } = await fixture();
    await migrate(db, migrations);
    await db.query(sql`ALTER TABLE housekeeping_shifts DROP COLUMN active`);
    await expect(migrate(db, migrations)).rejects.toThrow();
  });
  it("creates a recoverable DB-managed embedded backup before pending work and persists across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "startup-backup-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const config = loadConfig({
      APP_MODE: "native",
      NODE_ENV: "test",
      APP_URL: "http://localhost:3000",
      DB_FILE: join(dir, "db"),
    });
    const migrations = join(dir, "migrations");
    await cp(migrationPath, migrations, { recursive: true });
    let db = await openDb(false, config);
    try {
      await expect(openDb(false, config)).rejects.toThrow("Another deployment");
      await migrate(db, migrations);
      await db.query(
        sql`INSERT INTO tenants VALUES ('retained','Backup fixture')`,
      );
      await writeFile(
        join(migrations, "0007_backup_test.sql"),
        "ALTER TABLE tenants ADD COLUMN backup_note text;",
      );
      const report = await migrate(db, migrations);
      expect(report.backup).toBeTruthy();
      const restored = new PGlite({
        loadDataDir: new Blob([await readFile(report.backup!)]),
      });
      try {
        expect(
          (await restored.query("SELECT name FROM tenants WHERE id='retained'"))
            .rows,
        ).toEqual([{ name: "Backup fixture" }]);
        expect(
          (
            await restored.query(
              "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
            )
          ).rows,
        ).toEqual([{ version: "0006" }]);
      } finally {
        await restored.close();
      }
    } finally {
      await db.close();
    }
    db = await openDb(false, config);
    try {
      expect(await migrate(db, migrations)).toMatchObject({
        applied: 0,
        current: "0007",
      });
      expect(await db.query(sql`SELECT name FROM tenants`)).toEqual([
        { name: "Backup fixture" },
      ]);
    } finally {
      await db.close();
    }
  }, 60000);
  it("refuses missing or invalid production embedded paths instead of initializing replacement data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "startup-missing-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const config = loadConfig({
      APP_MODE: "native",
      NODE_ENV: "production",
      APP_URL: "http://localhost:3000",
      ENCRYPTION_KEY: "a".repeat(64),
      DB_FILE: join(dir, "missing"),
    });
    await expect(openDb(false, config)).rejects.toThrow("replacement");
    await writeFile(join(dir, "not-a-directory"), "fixture");
    await expect(
      openDb(false, { ...config, databasePath: join(dir, "not-a-directory") }),
    ).rejects.toThrow("directory");
  });
  it("reports an unavailable external DB without falling back to embedded", async () => {
    const config = loadConfig({
      APP_MODE: "native",
      NODE_ENV: "test",
      APP_URL: "http://localhost:3000",
      DB_TYPE: "postgres",
      DB_HOST: "127.0.0.1",
      DB_PORT: "1",
      DB_USER: "startup_test",
      DB_PASSWORD: "unavailable-test-secret",
    });
    const db = await openDb(false, config);
    try {
      await expect(db.checkConnection()).rejects.toThrow("connection failed");
    } finally {
      await db.close();
    }
  });
});
