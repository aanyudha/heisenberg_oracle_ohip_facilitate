import type { Worksheet } from "./index.js";

// Shared deterministic preview/commit calculation. Selected work is removed
// from existing loads before redistribution, so reassignment is counted once.
export function distributeRooms(
  sheet: Pick<Worksheet, "rooms" | "assignments">,
  roomIds: string[],
  attendantIds: string[],
  mode: "equal" | "credits",
) {
  const ids = [...new Set(attendantIds)].sort();
  if (!ids.length || new Set(roomIds).size !== roomIds.length)
    throw Error("Select unique rooms and at least one attendant");
  const selected = new Set(roomIds);
  const rooms = roomIds.map((id) => {
    const room = sheet.rooms.find((r) => r.id === id);
    if (!room) throw Error(`Room ${id} is absent from the authorized feed`);
    return room;
  });
  const relevant = sheet.rooms.filter(
    (r) => selected.has(r.id) || ids.includes(sheet.assignments[r.id]),
  );
  const validCredits = relevant.every(
    (r) => r.credits !== null && Number.isFinite(r.credits) && r.credits >= 0,
  );
  const effectiveMode =
    mode === "credits" && validCredits ? "credits" : "equal";
  const rows = ids.map((attendantId) => {
    const existing = sheet.rooms.filter(
      (r) => !selected.has(r.id) && sheet.assignments[r.id] === attendantId,
    );
    return {
      attendantId,
      roomIds: [] as string[],
      existingRooms: existing.length,
      existingCredits: existing.reduce((n, r) => n + (r.credits ?? 0), 0),
      newCredits: 0,
      missingCredits: existing.filter((r) => r.credits === null).length,
    };
  });
  rooms.sort(
    (a, b) =>
      (effectiveMode === "credits" ? b.credits! - a.credits! : 0) ||
      a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  for (const room of rooms) {
    const target = [...rows].sort(
      (a, b) =>
        (effectiveMode === "credits"
          ? a.existingCredits + a.newCredits - b.existingCredits - b.newCredits
          : a.existingRooms +
            a.roomIds.length -
            b.existingRooms -
            b.roomIds.length) ||
        a.existingRooms +
          a.roomIds.length -
          b.existingRooms -
          b.roomIds.length ||
        a.attendantId.localeCompare(b.attendantId),
    )[0];
    target.roomIds.push(room.id);
    target.newCredits += room.credits ?? 0;
    if (room.credits === null) target.missingCredits++;
  }
  return {
    rows,
    effectiveMode,
    fallback: mode === "credits" && !validCredits,
    reassigned: rows.reduce(
      (n, row) =>
        n +
        row.roomIds.filter(
          (id) =>
            sheet.assignments[id] && sheet.assignments[id] !== row.attendantId,
        ).length,
      0,
    ),
  };
}
