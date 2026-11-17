import type { Worksheet, WorksheetStaff } from "@hospitality/contracts";
export function staffReason(staff: WorksheetStaff) {
  const reason =
    staff.eligibilityReason ||
    (!staff.active ? "inactive" : !staff.available ? "not_scheduled" : null);
  return reason
    ? {
        inactive: "Inactive",
        wrong_role: "Wrong Role",
        wrong_property: "Wrong Property",
        not_scheduled: "Not Scheduled",
        off_shift: "Not Scheduled",
        not_registered: "No longer registered",
      }[reason]
    : "Scheduled";
}
export const canSchedule = (staff: WorksheetStaff) =>
  staff.active &&
  !staff.available &&
  (!staff.eligibilityReason ||
    ["not_scheduled", "off_shift"].includes(staff.eligibilityReason));
export function supervisorForRooms(sheet: Worksheet, ids: string[]) {
  const owners = ids.map((id) => sheet.roomSupervisors?.[id]);
  return owners.length && owners.every((id) => id && id === owners[0])
    ? owners[0]!
    : null;
}
