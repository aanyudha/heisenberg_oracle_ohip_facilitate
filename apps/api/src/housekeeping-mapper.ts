import { z } from "zod";
import type { WorksheetRoom } from "@hospitality/contracts";
import { OhipError } from "./ohip-gateway.js";

const text = z.string().max(2000);
const code = z.string().trim().min(1).max(100);
const resv = z.object({
  reservationStatusInfo: text.optional(),
  vipStatus: z
    .object({ code: text.optional(), value: text.optional() })
    .optional(),
  stayDateInfo: z
    .object({
      timeSpan: z
        .object({
          startDate: z.iso.date().optional(),
          endDate: z.iso.date().optional(),
        })
        .optional(),
    })
    .optional(),
});
const roomSchema = z.object({
  roomId: code,
  floor: text.optional(),
  roomType: z
    .object({ roomType: text.optional(), pseudoRoom: z.boolean().optional() })
    .optional(),
  roomSection: z
    .object({
      daySectionCode: text.optional(),
      eveningSectionCode: text.optional(),
    })
    .optional(),
  housekeeping: z.object({
    housekeepingRoomStatus: z.object({
      housekeepingRoomStatus: z.enum([
        "Clean",
        "Dirty",
        "Pickup",
        "Inspected",
        "OutOfOrder",
        "OutOfService",
      ]),
      reservationStatusList: z.array(text).optional(),
      frontOfficeStatus: text.optional(),
    }),
    guestServiceRequest: text.optional(),
    cleaningPriority: z
      .object({ prioritySequence: z.number().optional() })
      .optional(),
    facilityTaskCode: z.array(text).optional(),
  }),
  resvInfo: z.array(resv).max(1000).optional(),
  discrepancy: z.array(text).optional(),
});
export const overviewSchema = z.object({
  housekeepingRoomInfo: z.object({
    housekeepingRooms: z.object({
      room: z.array(roomSchema).max(100),
      hotelId: text.optional(),
    }),
    hasMore: z.boolean().optional(),
    totalResults: z.coerce.number().int().nonnegative().optional(),
  }),
});
export function mapHousekeepingOverview(
  payload: unknown,
  date: string,
  hotelId: string,
  offset = 0,
): {
  rooms: WorksheetRoom[];
  hasMore: boolean;
  totalResults?: number;
  rawCount: number;
} {
  const parsed = overviewSchema.parse(payload).housekeepingRoomInfo;
  if (
    parsed.housekeepingRooms.hotelId &&
    parsed.housekeepingRooms.hotelId !== hotelId
  )
    throw new OhipError(422, "hotel_scope_mismatch");
  const rooms = parsed.housekeepingRooms.room
    .filter((r) => !r.roomType?.pseudoRoom)
    .map((r) => {
      const statuses =
        r.housekeeping.housekeepingRoomStatus.reservationStatusList || [];
      const reservations = r.resvInfo || [];
      const departure =
        statuses.includes("DueOut") ||
        statuses.includes("Departed") ||
        reservations.some((v) => v.stayDateInfo?.timeSpan?.endDate === date);
      const arrival =
        statuses.includes("Arrival") ||
        reservations.some((v) => v.stayDateInfo?.timeSpan?.startDate === date);
      const stayover =
        statuses.includes("StayOver") ||
        statuses.includes("Stayover") ||
        reservations.some(
          (v) =>
            !!v.stayDateInfo?.timeSpan?.startDate &&
            v.stayDateInfo.timeSpan.startDate <= date &&
            !!v.stayDateInfo.timeSpan.endDate &&
            v.stayDateInfo.timeSpan.endDate > date,
        );
      const status =
        r.housekeeping.housekeepingRoomStatus.housekeepingRoomStatus;
      const dnd = r.housekeeping.guestServiceRequest === "DoNotDisturb",
        makeUpRoom = r.housekeeping.guestServiceRequest === "MakeUpRoom";
      const vip = reservations.some(
        (v) => !!(v.vipStatus?.code || v.vipStatus?.value),
      );
      return {
        id: r.roomId,
        occupancy: ["Occupied", "Vacant"].includes(
          r.housekeeping.housekeepingRoomStatus.frontOfficeStatus || "",
        )
          ? r.housekeeping.housekeepingRoomStatus.frontOfficeStatus
          : null,
        floor: r.floor || null,
        floorSource: r.floor ? "OHIP" : "unavailable",
        section: r.roomSection?.daySectionCode || null,
        roomType: r.roomType?.roomType || null,
        status,
        departure,
        stayover: !departure && stayover,
        arrival,
        vip,
        dnd,
        makeUpRoom,
        outOfOrder: status === "OutOfOrder",
        outOfService: status === "OutOfService",
        priority:
          vip ||
          makeUpRoom ||
          r.housekeeping.cleaningPriority?.prioritySequence !== undefined,
        tasks: r.housekeeping.facilityTaskCode || [],
        remarks: [
          ...(dnd ? ["Do Not Disturb"] : []),
          ...(makeUpRoom ? ["Make Up Room"] : []),
          ...(r.discrepancy || []).map((s) => "Discrepancy: " + s),
        ],
        credits: null,
        creditSource: "not_configured",
        observedAt: null,
      } as WorksheetRoom;
    });
  const rawCount = parsed.housekeepingRooms.room.length;
  if (
    parsed.hasMore === false &&
    parsed.totalResults !== undefined &&
    parsed.totalResults > offset + rawCount
  )
    throw new OhipError(422, "incomplete_room_feed");
  if (
    parsed.hasMore === undefined &&
    parsed.totalResults === undefined &&
    rawCount === 100
  )
    throw new OhipError(422, "pagination_metadata_missing");
  return {
    rooms,
    rawCount,
    hasMore:
      parsed.hasMore ??
      (parsed.totalResults !== undefined &&
        parsed.totalResults > offset + rawCount),
    totalResults: parsed.totalResults,
  };
}
const taskSchema = z.object({
  taskAssignmentInfo: z
    .array(
      z.object({
        hotelId: text.optional(),
        taskDate: z.iso.date().optional(),
        taskSheetsCount: z.coerce.number().int().nonnegative().optional(),
        taskCodes: z
          .array(
            z.object({ code: text.optional(), description: text.optional() }),
          )
          .optional(),
        taskSheets: z
          .array(
            z.object({
              hotelId: text.optional(),
              date: z.iso.date().optional(),
              sheetNumber: z.coerce.number().int().optional(),
              taskSeqNo: z.coerce.number().int().optional(),
              taskCodes: z
                .array(
                  z.object({
                    code: text.optional(),
                    description: text.optional(),
                  }),
                )
                .optional(),
              rooms: z
                .array(
                  z.object({
                    roomId: code,
                    totalCredits: z.number().min(0).max(99999).optional(),
                    instructions: text.optional(),
                    hasPriority: z.boolean().optional(),
                  }),
                )
                .default([]),
            }),
          )
          .default([]),
      }),
    )
    .max(4000),
});
export function mergeHousekeepingTasks(
  rooms: WorksheetRoom[],
  payload: unknown,
  date: string,
  hotelId: string,
) {
  const tasks = taskSchema.parse(payload).taskAssignmentInfo;
  const seen = new Set<string>();
  const byRoom = new Map<
    string,
    {
      credits: number;
      hasCredits: boolean;
      tasks: Set<string>;
      remarks: Set<string>;
      priority: boolean;
    }
  >();
  for (const assignment of tasks) {
    if (
      assignment.taskSheetsCount !== undefined &&
      assignment.taskSheetsCount > assignment.taskSheets.length
    )
      throw new OhipError(422, "incomplete_task_sheets");
    if (
      (assignment.hotelId && assignment.hotelId !== hotelId) ||
      (assignment.taskDate && assignment.taskDate !== date)
    )
      throw new OhipError(422, "task_scope_mismatch");
    for (const [sheetIndex, sheet] of assignment.taskSheets.entries()) {
      if (
        (sheet.hotelId && sheet.hotelId !== hotelId) ||
        (sheet.date && sheet.date !== date)
      )
        throw new OhipError(422, "task_scope_mismatch");
      for (const room of sheet.rooms) {
        const key = JSON.stringify([
          (sheet.taskCodes || assignment.taskCodes || [])
            .map((t) => t.code || t.description)
            .sort(),
          sheet.taskSeqNo ?? sheet.sheetNumber ?? sheetIndex,
          room.roomId,
        ]);
        if (seen.has(key))
          throw new OhipError(422, "duplicate_task_sheet_room");
        seen.add(key);
        const v = byRoom.get(room.roomId) || {
          credits: 0,
          hasCredits: false,
          tasks: new Set<string>(),
          remarks: new Set<string>(),
          priority: false,
        };
        // Each existing task sheet's per-room credits represent its task workload.
        if (room.totalCredits !== undefined) {
          v.credits += room.totalCredits;
          v.hasCredits = true;
        }
        for (const t of sheet.taskCodes || assignment.taskCodes || [])
          if (t.code || t.description) v.tasks.add(t.description || t.code!);
        if (room.instructions) v.remarks.add(room.instructions);
        v.priority ||= !!room.hasPriority;
        byRoom.set(room.roomId, v);
      }
    }
  }
  return rooms.map((r) => {
    const v = byRoom.get(r.id);
    if (!v) return r;
    return {
      ...r,
      tasks: [...new Set([...r.tasks, ...v.tasks])],
      remarks: [...new Set([...r.remarks, ...v.remarks])],
      priority: r.priority || v.priority,
      credits: v.hasCredits ? Math.round(v.credits * 100) / 100 : r.credits,
      creditSource: v.hasCredits ? ("OHIP" as const) : r.creditSource,
    };
  });
}
