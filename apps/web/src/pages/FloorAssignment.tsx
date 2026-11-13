import { useState } from "react";
import type { Worksheet, WorksheetOperation } from "@hospitality/contracts";
export default function FloorAssignment({
  sheet,
  move,
}: {
  sheet: Worksheet;
  move: (op: WorksheetOperation) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState("");
  const rows = sheet.floorAssignments || [];
  const supervisors = sheet.supervisors.filter((s) => s.active && s.available);
  const change = (floorIds: string[], supervisorId: string | null) => {
    move({ type: "floors", floorIds, supervisorId, replace: true });
    setSelected([]);
  };
  return (
    <section
      className="worksheet-floor-assignment"
      aria-label={sheet.manager ? "Floor Assignment" : "My Floors"}
    >
      <div className="worksheet-floor-title">
        <h2>{sheet.manager ? "Floor Assignment" : "My Floors"}</h2>
        <p>
          {sheet.manager
            ? "Assign primary floor responsibility. Existing attendant work is preserved as visible room-specific exceptions when responsibility changes."
            : "Your floors and room-specific responsibility are assigned by the manager. No floor selection is required."}
        </p>
      </div>
      {sheet.manager && selected.length > 0 && (
        <div className="worksheet-batch">
          <strong>{selected.length} floors selected</strong>
          <select
            aria-label="Batch floor supervisor"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose supervisor</option>
            <option value="unassigned">No primary supervisor</option>
            {supervisors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            disabled={!target}
            onClick={() =>
              change(selected, target === "unassigned" ? null : target)
            }
          >
            Assign selected floors
          </button>
          <button onClick={() => setSelected([])}>Clear floors</button>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Floor</th>
              <th>Total Rooms</th>
              <th>Supervisor</th>
              <th>Assigned</th>
              <th>Unassigned</th>
              <th>Workload Credits</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id} data-floor-id={f.id}>
                <td>
                  {sheet.manager && (
                    <input
                      type="checkbox"
                      aria-label={`Select floor ${f.id}`}
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
                      {f.exceptionRooms} room-specific{" "}
                      {f.exceptionRooms === 1 ? "exception" : "exceptions"} ·
                      assigned work retained
                    </small>
                  )}
                  {f.conflict && (
                    <small role="alert">Primary supervisor conflict</small>
                  )}
                </td>
                <td>{f.totalRooms}</td>
                <td>
                  {sheet.manager ? (
                    <select
                      aria-label={`Supervisor for floor ${f.id}`}
                      value={f.supervisorId || ""}
                      onChange={(e) => change([f.id], e.target.value || null)}
                    >
                      <option value="">No primary supervisor</option>
                      {f.supervisorId &&
                        !supervisors.some((s) => s.id === f.supervisorId) && (
                          <option value={f.supervisorId} disabled>
                            Unavailable supervisor
                          </option>
                        )}
                      {supervisors.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    sheet.supervisors.find((s) => s.id === f.supervisorId)
                      ?.name || "Room-specific coverage"
                  )}
                </td>
                <td>{f.assignedRooms}</td>
                <td>{f.unassignedRooms}</td>
                <td>
                  {f.credits}
                  {f.missingCredits > 0 && (
                    <small>{f.missingCredits} unconfigured</small>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p className="worksheet-drop-hint">
          No verified floor data or assigned floor responsibility is available.
        </p>
      )}
    </section>
  );
}
