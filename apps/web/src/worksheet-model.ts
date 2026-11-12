import type {
  Worksheet,
  WorksheetOperation,
  WorksheetRoom,
} from "@hospitality/contracts";
export function moveWorksheet(
  sheet: Worksheet,
  operation: WorksheetOperation,
): Worksheet {
  if (operation.type === "team")
    return {
      ...sheet,
      team: { ...sheet.team, [operation.attendantId]: operation.supervisorId },
    };
  const assignments = { ...sheet.assignments };
  for (const id of operation.roomIds) {
    if (operation.attendantId) assignments[id] = operation.attendantId;
    else delete assignments[id];
  }
  return { ...sheet, assignments };
}
export function workload(
  rooms: WorksheetRoom[],
  progress: Record<string, string> = {},
) {
  return {
    rooms: rooms.length,
    credits:
      Math.round(rooms.reduce((n, r) => n + (r.credits ?? 0), 0) * 100) / 100,
    missingCredits: rooms.filter((r) => r.credits === null).length,
    departure: rooms.filter((r) => r.departure).length,
    stayover: rooms.filter((r) => r.stayover).length,
    priority: rooms.filter((r) => r.priority).length,
    outstanding: rooms.filter((r) => progress[r.id] !== "completed").length,
  };
}
