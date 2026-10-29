import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canAdmin } from "@hospitality/contracts";
import { sql, type Database } from "./db.js";
import { appendEvent } from "./realtime.js";
const fail = (statusCode: number, message: string) =>
  Object.assign(Error(message), { statusCode });
const name = z.string().trim().min(1).max(100);
const kinds = z.enum(["tenants", "organizations", "properties", "users"]);
export function registerLocalManagement(app: FastifyInstance, db: Database) {
  for (const method of ["PATCH", "DELETE"] as const)
    app.route({
      method,
      url: "/api/admin/:kind/:id",
      // User access editing uses the existing, stricter membership endpoint.
      async handler(req) {
        const u = req.principal;
        if (!canAdmin(u.role)) throw fail(403, "Permission denied");
        const { kind, id } = z
          .object({ kind: kinds, id: name })
          .parse(req.params);
        if (method === "PATCH" && kind === "users")
          throw fail(400, "Use user access editor");
        if (
          kind === "tenants" &&
          (u.role !== "platform_admin" || id !== u.tenantId)
        )
          throw fail(403, "Tenant access denied");
        if (kind === "properties" && !u.properties.includes(id))
          throw fail(403, "Property access denied");
        const b =
          method === "PATCH"
            ? (kind === "properties"
                ? z.strictObject({
                    name,
                    organizationId: name,
                    timezone: z
                      .string()
                      .max(100)
                      .refine((v) => {
                        try {
                          new Intl.DateTimeFormat("en", { timeZone: v });
                          return true;
                        } catch {
                          return false;
                        }
                      }),
                  })
                : z.strictObject({ name })
              ).parse(req.body)
            : null;
        await db.orm.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${u.tenantId},7291043001))`,
          );
          const where =
            kind === "tenants"
              ? sql`id=${u.tenantId}`
              : kind === "users"
                ? sql`tenant_id=${u.tenantId} AND user_id=${id}`
                : sql`tenant_id=${u.tenantId} AND id=${id}`;
          const table = kind === "users" ? "memberships" : kind;
          const target = (
            await tx.execute(
              sql`SELECT * FROM ${sql.identifier(table)} WHERE ${where}`,
            )
          ).rows[0];
          if (
            !target ||
            (
              await tx.execute(
                sql`SELECT 1 FROM local_archives WHERE tenant_id=${u.tenantId} AND kind=${kind} AND target=${id}`,
              )
            ).rows.length
          )
            throw fail(404, "Record not found");
          if (kind === "users") {
            if (id === u.id)
              throw fail(
                409,
                "Use another administrator to archive your membership",
              );
            if (target.role === "platform_admin" && u.role !== "platform_admin")
              throw fail(403, "Cannot manage platform role");
            if (
              ["platform_admin", "group_admin"].includes(String(target.role)) &&
              !(
                await tx.execute(
                  sql`SELECT 1 FROM memberships m WHERE m.tenant_id=${u.tenantId} AND m.user_id!=${id} AND m.role IN ('platform_admin','group_admin') AND NOT EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=m.tenant_id AND a.kind='users' AND a.target=m.user_id)`,
                )
              ).rows.length
            )
              throw fail(409, "Last administrator cannot be archived");
            const grants = (
              await tx.execute(
                sql`SELECT property_id FROM property_grants WHERE tenant_id=${u.tenantId} AND user_id=${id}`,
              )
            ).rows;
            if (
              grants.some((g) => !u.properties.includes(String(g.property_id)))
            )
              throw fail(403, "Property access denied");
            if (
              (
                await tx.execute(
                  sql`SELECT 1 FROM tasks WHERE tenant_id=${u.tenantId} AND assignee=${id} AND status!='done' LIMIT 1`,
                )
              ).rows.length
            )
              throw fail(
                409,
                "Reassign active tasks before archiving this user",
              );
            await tx.execute(
              sql`DELETE FROM sessions WHERE tenant_id=${u.tenantId} AND user_id=${id}`,
            );
          }
          if (method === "DELETE") {
            if (kind === "properties") {
              if (
                (
                  await tx.execute(
                    sql`SELECT 1 WHERE EXISTS(SELECT 1 FROM ohip_connection_properties WHERE tenant_id=${u.tenantId} AND property_id=${id}) OR EXISTS(SELECT 1 FROM connections WHERE tenant_id=${u.tenantId} AND property_id=${id}) OR EXISTS(SELECT 1 FROM property_grants WHERE tenant_id=${u.tenantId} AND property_id=${id} AND user_id!=${u.id}) OR EXISTS(SELECT 1 FROM retry_jobs WHERE tenant_id=${u.tenantId} AND property_id=${id} AND state IN ('queued','running')) OR EXISTS(SELECT 1 FROM tasks WHERE tenant_id=${u.tenantId} AND property_id=${id} AND status!='done')`,
                  )
                ).rows.length
              )
                throw fail(
                  409,
                  "Remove assignments, connections, other user grants and active jobs/tasks before archiving property",
                );
            }
            if (kind === "organizations" || kind === "tenants") {
              const child =
                kind === "organizations" ? "properties" : "organizations";
              const parent =
                kind === "organizations"
                  ? sql`AND organization_id=${id}`
                  : sql``;
              if (
                (
                  await tx.execute(
                    sql`SELECT 1 FROM ${sql.identifier(child)} c WHERE tenant_id=${u.tenantId} ${parent} AND NOT EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=c.tenant_id AND a.kind=${child} AND a.target=c.id) LIMIT 1`,
                  )
                ).rows.length
              )
                throw fail(409, "Archive dependent records first");
            }
            await tx.execute(
              sql`INSERT INTO local_archives(tenant_id,kind,target) VALUES (${u.tenantId},${kind},${id})`,
            );
            if (kind === "tenants")
              await tx.execute(
                sql`DELETE FROM sessions WHERE tenant_id=${u.tenantId}`,
              );
          } else {
            if (
              kind === "properties" &&
              b &&
              "organizationId" in b &&
              "timezone" in b
            ) {
              if (
                !(
                  await tx.execute(
                    sql`SELECT 1 FROM organizations o WHERE tenant_id=${u.tenantId} AND id=${b.organizationId} AND NOT EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=o.tenant_id AND a.kind='organizations' AND a.target=o.id)`,
                  )
                ).rows.length
              )
                throw fail(403, "Organization denied");
              await tx.execute(
                sql`UPDATE properties SET name=${b.name},organization_id=${b.organizationId},timezone=${b.timezone} WHERE ${where}`,
              );
            } else if (b)
              await tx.execute(
                sql`UPDATE ${sql.identifier(table)} SET name=${b.name} WHERE ${where}`,
              );
          }
          await tx.execute(
            sql`INSERT INTO audit_logs(id,tenant_id,property_id,actor,action,target) VALUES (${randomUUID()},${u.tenantId},${kind === "properties" ? id : null},${u.id},${kind + "." + (method === "DELETE" ? "archive" : "update")},${id})`,
          );
          await appendEvent(tx, u.tenantId, null, "reconcile");
        });
        return { ok: true };
      },
    });
}
