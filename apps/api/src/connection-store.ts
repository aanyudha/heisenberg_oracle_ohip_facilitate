import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { decrypt, encrypt } from "./security.js";
export type ConnectionTransaction = {
  execute(query: SQL): Promise<{ rows: any[] }>;
};
export type Credentials = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  appKey: string;
  enterpriseId: string;
};
export function credentials(row: Record<string, any>): Credentials {
  return {
    baseUrl: row.base_url,
    clientId: row.client_id,
    clientSecret: decrypt(row.encrypted_client_secret),
    appKey: decrypt(row.encrypted_app_key),
    enterpriseId: row.enterprise_id,
  };
}
export function sameCredentials(a: Credentials, b: Credentials) {
  return (
    a.baseUrl === b.baseUrl &&
    a.clientId === b.clientId &&
    a.clientSecret === b.clientSecret &&
    a.appKey === b.appKey &&
    a.enterpriseId === b.enterpriseId
  );
}
// Caller serializes writes per tenant. No credential fingerprint or secret is exposed.
export async function findOrCreateConnection(
  tx: ConnectionTransaction,
  tenantId: string,
  value: Credentials,
  status = "connected",
) {
  const candidates = (
    await tx.execute(
      sql`SELECT * FROM ohip_connections WHERE tenant_id=${tenantId} AND base_url=${value.baseUrl} AND client_id=${value.clientId} AND enterprise_id=${value.enterpriseId}`,
    )
  ).rows;
  const existing = candidates.find((row) =>
    sameCredentials(credentials(row), value),
  );
  if (existing) return existing.id as string;
  const id = randomUUID();
  await tx.execute(
    sql`INSERT INTO ohip_connections(id,tenant_id,base_url,client_id,encrypted_client_secret,encrypted_app_key,enterprise_id,status) VALUES (${id},${tenantId},${value.baseUrl},${value.clientId},${encrypt(value.clientSecret)},${encrypt(value.appKey)},${value.enterpriseId},${status})`,
  );
  return id;
}
export async function migrateLegacyConnections(tx: ConnectionTransaction) {
  const legacy = (
    await tx.execute(
      sql`SELECT * FROM connections WHERE mode='real' AND encrypted_secret IS NOT NULL ORDER BY id`,
    )
  ).rows;
  for (const row of legacy) {
    let value: Credentials;
    try {
      const secret = decrypt(row.encrypted_secret);
      if (
        ![secret.clientId, secret.clientSecret, secret.applicationKey].every(
          (v) => typeof v === "string" && v.length,
        )
      )
        throw Error();
      value = {
        baseUrl: new URL(row.gateway).origin,
        clientId: secret.clientId,
        clientSecret: secret.clientSecret,
        appKey: secret.applicationKey,
        enterpriseId: row.enterprise_id,
      };
    } catch {
      throw Error(
        "Cannot migrate existing OHIP credentials. Restore the original ENCRYPTION_KEY and verify legacy configuration; no credential or assignment has been changed.",
      );
    }
    const connectionId = await findOrCreateConnection(
      tx,
      row.tenant_id,
      value,
      row.status,
    );
    await tx.execute(
      sql`INSERT INTO ohip_connection_properties(id,tenant_id,connection_id,property_id,hotel_id,is_primary,validation_status,last_validated_at) VALUES (${randomUUID()},${row.tenant_id},${connectionId},${row.property_id},${row.hotel_id},NOT EXISTS(SELECT 1 FROM ohip_connection_properties WHERE tenant_id=${row.tenant_id} AND connection_id=${connectionId} AND is_primary),${row.last_sync ? "validated" : "pending"},${row.last_sync})`,
    );
    // Only clear the old encrypted blob after both encrypted fields and assignment exist.
    // Legacy chain/gateway/hotel columns remain untouched for historical consumers.
    await tx.execute(
      sql`UPDATE connections SET encrypted_secret=NULL WHERE id=${row.id}`,
    );
  }
}
