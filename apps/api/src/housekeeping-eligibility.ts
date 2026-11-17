import { sql, type Database } from "./db.js";
import type { WorksheetScope, WorksheetStaff } from "@hospitality/contracts";
type Tx = { execute: Database["orm"]["execute"] };
type StaffRow = {
  id: string;
  name: string;
  role: string;
  job_role: string | null;
  property_granted: boolean;
  archived: boolean;
  available: boolean | null;
};

// Only inspect current-property candidates or assignment references already
// authorized by the caller. Never enumerate other properties' staff.
export async function staffStatusRows(
  tx: Tx,
  tenantId: string,
  scope: WorksheetScope,
  ids: string[],
) {
  if (!ids.length) return new Map<string, StaffRow>();
  const rows = (
    await tx.execute(sql`SELECT u.id,u.name,m.role,h.job_role,s.available,
    EXISTS(SELECT 1 FROM property_grants g WHERE g.tenant_id=m.tenant_id AND g.user_id=u.id AND g.property_id=${scope.propertyId}) AS property_granted,
    EXISTS(SELECT 1 FROM local_archives a WHERE a.tenant_id=m.tenant_id AND (a.kind='tenants' OR (a.kind='users' AND a.target=u.id) OR (a.kind='properties' AND a.target=${scope.propertyId}))) AS archived
    FROM users u JOIN memberships m ON m.user_id=u.id AND m.tenant_id=${tenantId}
    LEFT JOIN housekeeping_staff_profiles h ON h.tenant_id=m.tenant_id AND h.user_id=u.id AND h.property_id=${scope.propertyId}
    LEFT JOIN housekeeping_staff_schedules s ON s.tenant_id=m.tenant_id AND s.property_id=${scope.propertyId} AND s.user_id=u.id AND s.business_date=${scope.date} AND s.shift_id=${scope.shiftId}
    WHERE u.id IN (${sql.join(
      [...new Set(ids)].map((id) => sql`${id}`),
      sql`, `,
    )})`)
  ).rows as StaffRow[];
  return new Map(rows.map((r) => [r.id, r]));
}
export function staffStatus(
  id: string,
  expectedRole: string,
  row: StaffRow | undefined,
): WorksheetStaff {
  const reason: WorksheetStaff["eligibilityReason"] = !row
    ? "not_registered"
    : row.archived
      ? "inactive"
      : !row.property_granted
        ? "wrong_property"
        : !["housekeeping", "hotel_manager"].includes(row.role) ||
            row.job_role !== expectedRole
          ? "wrong_role"
          : row.available === null
            ? "not_scheduled"
            : !row.available
              ? "off_shift"
              : null;
  return {
    id,
    name: row?.name || "Staff no longer registered",
    active: !reason || reason === "not_scheduled" || reason === "off_shift",
    available: !reason,
    eligibilityReason: reason,
  };
}
