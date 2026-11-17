import { useState } from "react";
import type { Worksheet, WorksheetOperation } from "@hospitality/contracts";
import { staffReason, canSchedule } from "../housekeeping-labels";
export default function FloorAssignment({
  sheet,
  move,
  disabled = false,
}: {
  sheet: Worksheet;
  move: (op: WorksheetOperation, scheduleIds?: string[]) => void;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState("");
  const [pending, setPending] = useState<{
    floorIds: string[];
    supervisorId: string;
  } | null>(null);
  const rows = sheet.floorAssignments || [];
  function assign(floorIds: string[], supervisorId: string | null) {
    const staff = sheet.supervisors.find((s) => s.id === supervisorId);
    if (staff && canSchedule(staff)) {
      setPending({ floorIds, supervisorId: staff.id });
      return;
    }
    move({ type: "floors", floorIds, supervisorId, replace: true });
    setSelected([]);
    setPending(null);
  }
  const options = (
    <>
      <option value="">Unassigned</option>
      {sheet.supervisors.map((s) => (
        <option key={s.id} value={s.id} disabled={!s.active}>
          {s.name}
          {!s.available ? " - " + staffReason(s) : ""}
        </option>
      ))}
    </>
  );
  return (
    <section
      className="worksheet-floor-assignment"
      aria-label={sheet.manager ? "Floor Assignment" : "My Floors"}
    >
      <div className="worksheet-floor-title">
        <h2>{sheet.manager ? "Floor Assignment" : "My Floors"}</h2>
      </div>
      {sheet.manager && selected.length > 0 && (
        <div className="worksheet-batch">
          <strong>{selected.length} floors selected</strong>
          <select
            aria-label="Batch floor supervisor"
            disabled={disabled}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Select Supervisor</option>
            <option value="unassigned">Unassigned</option>
            {sheet.supervisors.map((s) => (
              <option key={s.id} value={s.id} disabled={!s.active}>
                {s.name}
                {!s.available ? " - " + staffReason(s) : ""}
              </option>
            ))}
          </select>
          <button
            disabled={disabled || !target}
            onClick={() =>
              assign(selected, target === "unassigned" ? null : target)
            }
          >
            Assign selected floors
          </button>
          <button
            onClick={() => {
              setSelected([]);
              setPending(null);
            }}
          >
            Clear
          </button>
        </div>
      )}
      {pending && (
        <div
          className="worksheet-inline-action"
          role="region"
          aria-label="Add supervisor to shift and assign"
        >
          <p>
            Add{" "}
            <strong>
              {
                sheet.supervisors.find((s) => s.id === pending.supervisorId)
                  ?.name
              }
            </strong>{" "}
            to <strong>{sheet.shift.name}</strong> on {sheet.scope.date} and
            assign {pending.floorIds.length > 1 ? "floors" : "floor"}{" "}
            {pending.floorIds.join(", ")}.
          </p>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => {
              move(
                {
                  type: "floors",
                  floorIds: pending.floorIds,
                  supervisorId: pending.supervisorId,
                  replace: true,
                },
                [pending.supervisorId],
              );
              setPending(null);
              setSelected([]);
            }}
          >
            Add to Shift &amp; Assign
          </button>
          <button onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Floor</th>
              <th>Rooms</th>
              <th>Supervisor</th>
              <th>Assigned</th>
              <th>Unassigned</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} data-floor-id={f.id}>
                <td>
                  {sheet.manager && (
                    <input
                      type="checkbox"
                      aria-label={"Select floor " + f.id}
                      disabled={disabled}
                      checked={selected.includes(f.id)}
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, f.id]
                            : ids.filter((id) => id !== f.id),
                        )
                      }
                    />
                  )}
                  <strong>{f.id}</strong>
                  {f.exceptionRooms > 0 && (
                    <small>
                      {f.exceptionRooms} assigned rooms retain their current
                      team.
                    </small>
                  )}
                  {f.conflict && (
                    <small role="alert">
                      Supervisor conflict: review this floor.
                    </small>
                  )}
                </td>
                <td>{f.totalRooms}</td>
                <td>
                  {sheet.manager ? (
                    <select
                      aria-label={"Supervisor for floor " + f.id}
                      value={
                        pending?.floorIds.includes(f.id)
                          ? pending.supervisorId
                          : f.supervisorId || ""
                      }
                      disabled={disabled}
                      onChange={(e) => assign([f.id], e.target.value || null)}
                    >
                      {options}
                      {f.supervisorId &&
                        !sheet.supervisors.some(
                          (s) => s.id === f.supervisorId,
                        ) && (
                          <option disabled value={f.supervisorId}>
                            Previous Supervisor - review access
                          </option>
                        )}
                    </select>
                  ) : (
                    sheet.supervisors.find((s) => s.id === f.supervisorId)
                      ?.name || "Room coverage"
                  )}
                </td>
                <td>{f.assignedRooms}</td>
                <td>{f.unassignedRooms}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>No floors assigned.</p>}
    </section>
  );
}
