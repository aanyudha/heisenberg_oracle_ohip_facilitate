import type {
  Worksheet,
  WorksheetOperation,
  WorksheetRoom,
} from "@hospitality/contracts";
import {
  distributeRooms,
  resolveWorksheetCoverage,
  worksheetFloorRows,
  type SupervisorCoverage,
} from "@hospitality/contracts";
export function moveWorksheet(
  sheet: Worksheet,
  operation: WorksheetOperation,
): Worksheet {
  const team = { ...sheet.team };
  const assignments = { ...sheet.assignments };
  const supervisors: SupervisorCoverage[] = sheet.supervisors.map((s) => ({
    supervisorId: s.id,
    floors: [
      ...(sheet.supervisorFloors?.[s.id] ||
        sheet.floorAssignments
          ?.filter((f) => f.supervisorId === s.id)
          .map((f) => f.id) ||
        []),
    ],
    rooms: Object.entries(sheet.roomExceptions || {})
      .filter(([, id]) => id === s.id)
      .map(([id]) => id),
    coverage: sheet.rooms
      .filter(
        (r) =>
          (sheet.roomSupervisors?.[r.id] ||
            sheet.team[sheet.assignments[r.id]]) === s.id,
      )
      .map((r) => r.id),
  }));
  if (operation.type === "distribute") {
    const distribution = distributeRooms(
      sheet,
      operation.roomIds,
      operation.attendantIds,
      operation.mode,
    );
    for (const row of distribution.rows) {
      if (!team[row.attendantId] && sheet.selfRole === "supervisor")
        team[row.attendantId] = sheet.supervisors[0]?.id;
      for (const id of row.roomIds) assignments[id] = row.attendantId;
    }
  } else if (operation.type === "team")
    team[operation.attendantId] = operation.supervisorId;
  else if (operation.type === "floors") {
    for (const s of supervisors) {
      s.floors = s.floors.filter((f) => !operation.floorIds.includes(f));
      s.coverage = s.coverage.filter(
        (id) =>
          !sheet.rooms.some(
            (r) =>
              r.id === id && r.floor && operation.floorIds.includes(r.floor),
          ),
      );
    }
    if (operation.supervisorId)
      supervisors
        .find((s) => s.supervisorId === operation.supervisorId)
        ?.floors.push(...operation.floorIds);
  } else if (operation.type === "coverage") {
    for (const s of supervisors) {
      s.rooms = s.rooms.filter((r) => !operation.roomIds.includes(r));
      s.coverage = s.coverage.filter((r) => !operation.roomIds.includes(r));
    }
    if (operation.supervisorId)
      supervisors
        .find((s) => s.supervisorId === operation.supervisorId)
        ?.rooms.push(...operation.roomIds);
  } else
    for (const id of operation.roomIds) {
      if (operation.attendantId) assignments[id] = operation.attendantId;
      else delete assignments[id];
    }
  const projection = resolveWorksheetCoverage(
    supervisors,
    sheet.rooms,
    assignments,
    team,
  );
  return {
    ...sheet,
    assignments,
    team,
    supervisorFloors: Object.fromEntries(
      supervisors.map((s) => [s.supervisorId, s.floors]),
    ),
    floorAssignments: worksheetFloorRows(sheet.rooms, assignments, projection),
    roomSupervisors: projection.roomOwners,
    roomExceptions: projection.roomExceptions,
  };
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
