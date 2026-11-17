import { createHash } from "node:crypto";

// Reviewed release baselines. Historical files remain immutable. LF/CRLF are equivalent.
export const historicalChecksums: Record<string, string> = {
  "0001_initial.sql":
    "26f4da8e7458d295bf875be3a66bf002851b04415f29aba220bc4b1822e38934",
  "0002_ocim_connections.sql":
    "e8e75a534a083d9680abc11037aeebbf7c3aeb4e02d27d3effcad71dec5ec74b",
  "0003_local_controls.sql":
    "a0c82503f256bc00a10bacf503740781dee4be79fe547ae63e409bfc746dc0d6",
  "0004_housekeeping.sql":
    "387c136efc4d0f08cef435aaabf52c7083d46501e1e7ff11e50c38d678d31f06",
  "0005_housekeeping_worksheet.sql":
    "e45fdea748bf251a2c4c978c860d4e7edec2a79813c174e8ded9d0ff7979f3a4",
  "0006_housekeeping_shift_active.sql":
    "7c49ba0fdc4783fe13f46a5c3236f560e34153543418fb1e86925d85e8189441",
};
export const checksum = (body: string) =>
  createHash("sha256").update(body.replace(/\r\n/g, "\n")).digest("hex");
export function migrationStatements(body: string) {
  // Intentionally conservative subset: complex SQL requires explicit review.
  if (/\/\*|\$\$|\$[A-Za-z_]+\$/.test(body))
    throw Error(
      "Automatic migration requires reviewed simple SQL; complex SQL blocked",
    );
  return body
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}
export function validateMigration(name: string, body: string) {
  const digest = checksum(body);
  const expected = historicalChecksums[name];
  if (expected) {
    if (digest !== expected)
      throw Error(`Historical migration checksum mismatch: ${name}`);
    return digest;
  }
  const column =
    "[a-z_][a-z0-9_]*\\s+(?:text|boolean|integer|bigint|timestamptz|date|jsonb)(?:\\s+PRIMARY KEY)?(?:\\s+NOT NULL)?";
  const createTable = new RegExp(
    `^CREATE TABLE\\s+[a-z_][a-z0-9_]*\\s*\\(\\s*${column}(?:\\s*,\\s*${column})*\\s*\\)\\s*$`,
    "i",
  );
  for (const statement of migrationStatements(body)) {
    // No DML, destructive DDL, executable defaults/functions, unique constraints,
    // foreign keys or NOT NULL on existing tables in automatic future migrations.
    if (
      /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|GRANT|REVOKE|EXECUTE|CALL|DO|COPY|REFERENCES|UNIQUE|DEFAULT|CHECK|GENERATED|SELECT)\b/i.test(
        statement,
      ) ||
      !(
        createTable.test(statement) ||
        /^(CREATE INDEX\s+[a-z_][a-z0-9_]*\s+ON\s+[a-z_][a-z0-9_]*\s*\(\s*[a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*\s*\)\s*$|ALTER TABLE\s+[a-z_][a-z0-9_]*\s+ADD COLUMN\s+[a-z_][a-z0-9_]*\s+(?:text|boolean|integer|bigint|timestamptz|date|jsonb)\s*$)/i.test(
          statement,
        )
      )
    )
      throw Error(
        `Destructive/high-risk or unreviewed automatic migration blocked: ${name}`,
      );
  }
  return digest;
}
