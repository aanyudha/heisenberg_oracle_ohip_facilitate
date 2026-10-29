import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDeploymentLock } from "../apps/api/src/deployment-lock";
import { loadConfig } from "../apps/api/src/config";
import { openDb, migrate, sql, databaseError } from "../apps/api/src/db";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe("startup lifecycle", () => {
  it("allows only one winner when two processes recover a stale deployment lease", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deployment-recovery-"));
    directories.push(directory);
    const path = join(directory, ".deployment.lock");
    await writeFile(path, "old-process");
    const expired = new Date(Date.now() - 60000);
    await utimes(path, expired, expired);
    const attempts = await Promise.allSettled([
      acquireDeploymentLock(directory),
      acquireDeploymentLock(directory),
    ]);
    const winners = attempts.filter((result) => result.status === "fulfilled");
    for (const result of winners) await result.value();
    expect(winners).toHaveLength(1);
  });
  it("blocks a second deployment independently of mode/port and releases on shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deployment-lock-"));
    directories.push(directory);
    const release = await acquireDeploymentLock(directory);
    await expect(acquireDeploymentLock(directory)).rejects.toThrow(
      "Another deployment",
    );
    await release();
    await (
      await acquireDeploymentLock(directory)
    )();
  });
  it("preserves embedded records and applies migrations idempotently across reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deployment-db-"));
    directories.push(directory);
    const config = loadConfig({
      APP_MODE: "native",
      NODE_ENV: "test",
      APP_URL: "http://localhost:3000",
      DB_FILE: join(directory, "app.db"),
    });
    let db = await openDb(false, config);
    try {
      await db.checkConnection();
      await migrate(db);
      await migrate(db);
      await db.query(
        sql`INSERT INTO tenants VALUES ('persist-test','Persist test')`,
      );
      await db.query(
        sql`INSERT INTO ohip_connections(id,tenant_id,base_url,client_id,encrypted_client_secret,encrypted_app_key,enterprise_id,paused,status) VALUES ('paused-restart','persist-test','https://example.oraclecloud.com','client','opaque-existing-secret','opaque-existing-key','enterprise',true,'PAUSED')`,
      );
    } finally {
      await db.close();
    }
    db = await openDb(false, config);
    try {
      await db.checkConnection();
      await migrate(db);
      expect(
        await db.query(sql`SELECT name FROM tenants WHERE id='persist-test'`),
      ).toEqual([{ name: "Persist test" }]);
      expect(
        (
          await db.query(
            sql`SELECT paused,status,encrypted_client_secret FROM ohip_connections WHERE id='paused-restart'`,
          )
        )[0],
      ).toEqual({
        paused: true,
        status: "PAUSED",
        encrypted_client_secret: "opaque-existing-secret",
      });
      expect(
        await db.query(
          sql`SELECT version FROM schema_migrations ORDER BY version`,
        ),
      ).toEqual([
        { version: "0001" },
        { version: "0002" },
        { version: "0003" },
      ]);
    } finally {
      await db.close();
    }
  }, 60000);
  it("reports credential and connection errors without raw server details", () => {
    expect(
      databaseError({ cause: { code: "28P01", message: "secret" } }).message,
    ).toContain("authentication failed");
    expect(
      databaseError({ code: "ECONNREFUSED", message: "secret" }).message,
    ).toContain("connection failed");
    expect(databaseError({ code: "3D000" }).message).toContain("DB_NAME");
  });
});
