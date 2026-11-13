import type {
  SupervisorCoverage,
  WorksheetRoom,
  WorksheetFloor,
} from "./index.js";

// Floor primary ownership and explicit room exceptions share the existing
// supervisor assignment rows. Assigned work always retains its current team.
export function resolveWorksheetCoverage(
  supervisors: SupervisorCoverage[],
  rooms: Pick<WorksheetRoom, "id" | "floor">[],
  assignments: Record<string, string>,
  team: Record<string, string>,
) {
  const floorOwners = new Map<string, string | null>(),
    conflicts = new Set<string>();
  for (const r of rooms) if (r.floor) floorOwners.set(r.floor, null);
  const claimed = new Map<string, Set<string>>();
  for (const s of supervisors)
    for (const f of s.floors) {
      if (!claimed.has(f)) claimed.set(f, new Set());
      claimed.get(f)!.add(s.supervisorId);
    }
  for (const [f, owners] of claimed) {
    floorOwners.set(f, owners.size === 1 ? [...owners][0] : null);
    if (owners.size > 1) conflicts.add(f);
  }
  const explicit = new Map<string, Set<string>>(),
    legacy = new Map<string, Set<string>>();
  for (const s of supervisors) {
    for (const r of s.rooms) {
      if (!explicit.has(r)) explicit.set(r, new Set());
      explicit.get(r)!.add(s.supervisorId);
    }
    for (const r of s.coverage) {
      if (!legacy.has(r)) legacy.set(r, new Set());
      legacy.get(r)!.add(s.supervisorId);
    }
  }
  const known = new Set([
    ...rooms.map((r) => r.id),
    ...explicit.keys(),
    ...legacy.keys(),
    ...Object.keys(assignments),
  ]);
  const roomOwners = new Map<string, string | null>(),
    exceptions = new Map<string, string>();
  for (const id of known) {
    const floor = rooms.find((r) => r.id === id)?.floor,
      primary = floor ? floorOwners.get(floor) : null;
    const e = explicit.get(id),
      old = legacy.get(id);
    let owner =
      e?.size === 1
        ? [...e][0]
        : primary ||
          (!floor || !conflicts.has(floor)
            ? old?.size === 1
              ? [...old][0]
              : null
            : null);
    const attendant = Object.hasOwn(assignments, id) ? assignments[id] : null;
    if (attendant && Object.hasOwn(team, attendant)) owner = team[attendant];
    roomOwners.set(id, owner || null);
    if (owner && owner !== primary) exceptions.set(id, owner);
  }
  return {
    floorOwners: Object.fromEntries(floorOwners),
    roomOwners: Object.fromEntries(roomOwners),
    roomExceptions: Object.fromEntries(exceptions),
    conflictFloors: [...conflicts],
  };
}
export function worksheetFloorRows(
  rooms: WorksheetRoom[],
  assignments: Record<string, string>,
  projection: ReturnType<typeof resolveWorksheetCoverage>,
  includeFloors: string[] = [],
): WorksheetFloor[] {
  const floors = [
    ...new Set([
      ...rooms.map((r) => r.floor).filter((f): f is string => !!f),
      ...includeFloors,
    ]),
  ].sort();
  return floors.map((id) => {
    const list = rooms.filter((r) => r.floor === id),
      assigned = list.filter((r) => Object.hasOwn(assignments, r.id)).length;
    return {
      id,
      supervisorId: projection.floorOwners[id] || null,
      totalRooms: list.length,
      assignedRooms: assigned,
      unassignedRooms: list.length - assigned,
      credits:
        Math.round(list.reduce((n, r) => n + (r.credits ?? 0), 0) * 100) / 100,
      missingCredits: list.filter((r) => r.credits === null).length,
      exceptionRooms: list.filter((r) =>
        Object.hasOwn(projection.roomExceptions, r.id),
      ).length,
      conflict: projection.conflictFloors.includes(id),
    };
  });
}
