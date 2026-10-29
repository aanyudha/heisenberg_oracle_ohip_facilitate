import { sql, type Database } from "./db.js";
import { OhipReadOnlyError } from "./ohip-policy.js";
// The same transaction lock is held through outbound dispatch and by stop/resume.
// Stop waits for an already dispatched request, then prevents every later dispatch.
export function connectionDispatch(
  db: Database,
  tenant: string,
  property: string,
  connection: string,
  expected?: {
    credentialRevision: string;
    assignmentRevision: string;
    hotelId: string;
  },
) {
  return async (send: () => Promise<Response>) =>
    db.orm.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${tenant},7291043001))`,
      );
      const blocked = (
        await tx.execute(
          sql`SELECT 1 FROM ohip_connections o WHERE o.tenant_id=${tenant} AND o.id=${connection} AND (o.paused OR o.archived_at IS NOT NULL OR EXISTS(SELECT 1 FROM ohip_connection_properties m WHERE m.tenant_id=o.tenant_id AND m.connection_id=o.id AND m.property_id=${property} AND m.paused))`,
        )
      ).rows.length;
      const archived = (
        await tx.execute(
          sql`SELECT 1 FROM local_archives WHERE tenant_id=${tenant} AND (kind='tenants' OR (kind='properties' AND target=${property}))`,
        )
      ).rows.length;
      const changed =
        expected &&
        !(
          await tx.execute(
            sql`SELECT 1 FROM ohip_connections o JOIN ohip_connection_properties m ON m.tenant_id=o.tenant_id AND m.connection_id=o.id WHERE o.tenant_id=${tenant} AND o.id=${connection} AND o.updated_at::text=${expected.credentialRevision} AND m.property_id=${property} AND m.control_revision::text=${expected.assignmentRevision} AND m.hotel_id=${expected.hotelId}`,
          )
        ).rows.length;
      if (blocked || archived || changed) throw new OhipReadOnlyError();
      return send();
    });
}
