import { it, expect, describe } from "vitest";
import { readFile } from "node:fs/promises";
import { migrate, sql, type Database } from "../apps/api/src/db";
import { isolatedDatabase } from "./isolated-database";
import { seed } from "../apps/api/src/seed";
import { encrypt, decrypt } from "../apps/api/src/security";
async function legacyDb() {
  const isolated = await isolatedDatabase();
  const db = isolated.db,
    initial = await readFile(
      new URL("../db/migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );
  for (const statement of initial.split(";").filter((s) => s.trim()))
    await db.query(sql.raw(statement));
  await db.query(sql`CREATE TABLE schema_migrations(version text PRIMARY KEY)`);
  await db.query(sql`INSERT INTO schema_migrations VALUES ('0001')`);
  await seed(db, "Migration-test-password!");
  return isolated;
}
const original = {
  clientId: "legacy-client",
  clientSecret: "legacy-secret",
  applicationKey: "legacy-app-key",
};
async function insert(
  db: Database,
  tenant: string,
  id: string,
  hotelId: string,
  connected = true,
) {
  await db.query(
    sql`INSERT INTO properties(id,tenant_id,organization_id,name) VALUES (${id},${tenant},${tenant + "-group"},${id})`,
  );
  const cipher = encrypt(original);
  await db.query(
    sql`INSERT INTO connections(id,tenant_id,property_id,mode,environment,gateway,hotel_id,chain_code,enterprise_id,encrypted_secret,status,last_sync) VALUES (${id},${tenant},${id},'real','production','https://gateway.example.oraclecloud.com',${hotelId},'KEEP-HISTORY','ENTERPRISE',${cipher},${connected ? "connected" : "not_connected"},${connected ? "2026-10-20T00:00:00Z" : null}::timestamptz)`,
  );
  return cipher;
}
describe("safe OCIM credential migration", () => {
  it("preserves legacy credentials, historical chain data and assignments; deduplicates only within a tenant", async () => {
    process.env.ENCRYPTION_KEY = "c".repeat(64);
    const isolated = await legacyDb();
    const db = isolated.db;
    try {
      await insert(db, "demo", "legacy-a", "HOTEL_A");
      await insert(db, "demo", "legacy-b", "HOTEL_B", false);
      await insert(db, "other", "legacy-c", "HOTEL_C");
      await migrate(db);
      await migrate(db);
      const connections = await db.query(
        sql`SELECT * FROM ohip_connections ORDER BY tenant_id`,
      );
      expect(connections).toHaveLength(2);
      for (const c of connections) {
        expect(c.client_id).toBe(original.clientId);
        expect(decrypt(c.encrypted_client_secret)).toBe(original.clientSecret);
        expect(decrypt(c.encrypted_app_key)).toBe(original.applicationKey);
      }
      const mapped = await db.query(
        sql`SELECT * FROM ohip_connection_properties ORDER BY property_id`,
      );
      expect(mapped).toHaveLength(3);
      expect(mapped[0].connection_id).toBe(mapped[1].connection_id);
      expect(mapped[2].connection_id).not.toBe(mapped[0].connection_id);
      expect(mapped.map((m) => m.hotel_id)).toEqual([
        "HOTEL_A",
        "HOTEL_B",
        "HOTEL_C",
      ]);
      expect(mapped.map((m) => m.validation_status)).toEqual([
        "validated",
        "pending",
        "validated",
      ]);
      expect(
        mapped.filter((m) => m.tenant_id === "demo" && m.is_primary),
      ).toHaveLength(1);
      const history = await db.query(
        sql`SELECT chain_code,encrypted_secret FROM connections WHERE mode='real'`,
      );
      expect(
        history.every(
          (h) => h.chain_code === "KEEP-HISTORY" && h.encrypted_secret === null,
        ),
      ).toBe(true);
      expect(
        await db.query(
          sql`SELECT version FROM schema_migrations ORDER BY version`,
        ),
      ).toEqual([{ version: "0001" }, { version: "0002" }, { version: "0003" }]);
    } finally {
      await isolated.close();
    }
  }, 60000);
  it("rolls back the entire migration on a wrong encryption key, leaving original credentials recoverable", async () => {
    process.env.ENCRYPTION_KEY = "c".repeat(64);
    const isolated = await legacyDb();
    const db = isolated.db;
    try {
      const cipher = await insert(db, "demo", "legacy-rollback", "HOTEL_A");
      process.env.ENCRYPTION_KEY = "d".repeat(64);
      await expect(migrate(db)).rejects.toThrow(
        "Restore the original ENCRYPTION_KEY",
      );
      expect(
        (
          await db.query(
            sql`SELECT encrypted_secret FROM connections WHERE id='legacy-rollback'`,
          )
        )[0].encrypted_secret,
      ).toBe(cipher);
      expect(
        await db.query(sql`SELECT version FROM schema_migrations`),
      ).toEqual([{ version: "0001" }]);
      expect(
        (await db.query(sql`SELECT to_regclass('ohip_connections') AS name`))[0]
          .name,
      ).toBeNull();
      process.env.ENCRYPTION_KEY = "c".repeat(64);
      await migrate(db);
      expect(
        decrypt(
          (
            await db.query(
              sql`SELECT encrypted_client_secret FROM ohip_connections`,
            )
          )[0].encrypted_client_secret,
        ),
      ).toBe(original.clientSecret);
    } finally {
      await isolated.close();
    }
  }, 60000);
});
