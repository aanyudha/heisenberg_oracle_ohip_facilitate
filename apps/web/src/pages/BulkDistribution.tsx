import { useMemo, useState } from "react";
import {
  distributeRooms,
  type Worksheet,
  type WorksheetOperation,
  type WorksheetStaff,
} from "@hospitality/contracts";
import { canSchedule, supervisorForRooms } from "../housekeeping-labels";
export default function BulkDistribution({
  sheet,
  selected,
  eligible,
  move,
  disabled,
}: {
  sheet: Worksheet;
  selected: string[];
  eligible: WorksheetStaff[];
  move: (op: WorksheetOperation, scheduleIds?: string[]) => void;
  disabled: boolean;
}) {
  const [targets, setTargets] = useState<string[]>([]),
    [mode, setMode] = useState<"credits" | "equal">("credits"),
    [preview, setPreview] = useState(false);
  const plan = useMemo(
    () =>
      targets.length && selected.length
        ? distributeRooms(sheet, selected, targets, mode)
        : null,
    [sheet, selected, targets, mode],
  );
  const invalid = targets.some((id) => !eligible.some((a) => a.id === id));
  const shiftStaff = sheet.manager
    ? [...sheet.attendants, ...sheet.supervisors].filter(
        (s) =>
          canSchedule(s) &&
          (targets.includes(s.id) ||
            targets.some(
              (id) =>
                (sheet.team[id] || supervisorForRooms(sheet, selected)) ===
                s.id,
            )),
      )
    : [];
  return (
    <details className="worksheet-distribute">
      <summary>Distribute to multiple attendants</summary>
      <fieldset>
        <legend>Target attendants</legend>
        {eligible.map((a) => (
          <label key={a.id}>
            <input
              type="checkbox"
              checked={targets.includes(a.id)}
              onChange={(e) => {
                setTargets(
                  e.target.checked
                    ? [...targets, a.id]
                    : targets.filter((id) => id !== a.id),
                );
                setPreview(false);
              }}
            />
            {a.name}
            {!a.available ? " - Not Scheduled" : ""}
          </label>
        ))}
      </fieldset>
      <label>
        Distribution mode
        <select
          aria-label="Distribution mode"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as typeof mode);
            setPreview(false);
          }}
        >
          <option value="credits">Balanced Credits</option>
          <option value="equal">Equal Rooms</option>
        </select>
      </label>
      <button
        disabled={!plan || invalid || disabled}
        onClick={() => setPreview(true)}
      >
        Preview distribution
      </button>
      {preview && plan && (
        <section aria-label="Distribution preview">
          <h3>
            {selected.length} rooms → {targets.length} attendants
          </h3>
          <p>
            {plan.effectiveMode === "credits"
              ? "Balanced Credits"
              : "Equal Rooms"}{" "}
            · {plan.reassigned} reassigned rooms
          </p>
          {plan.fallback && (
            <p role="status">
              Credits incomplete: using Equal Rooms. No credits are invented.
            </p>
          )}
          {invalid && (
            <p role="alert">
              A target is no longer eligible. Select active rostered attendants.
            </p>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Attendant</th>
                  <th>Existing rooms</th>
                  <th>Selected rooms</th>
                  <th>Resulting rooms</th>
                  <th>Existing + selected credits</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((row) => (
                  <tr key={row.attendantId}>
                    <td>
                      {eligible.find((a) => a.id === row.attendantId)?.name ||
                        "Unavailable"}
                    </td>
                    <td>{row.existingRooms}</td>
                    <td>{row.roomIds.length}</td>
                    <td>{row.existingRooms + row.roomIds.length}</td>
                    <td>
                      {row.existingCredits} + {row.newCredits}
                      {row.missingCredits
                        ? ` (${row.missingCredits} unconfigured)`
                        : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shiftStaff.length > 0 && (
            <p>
              This will add {shiftStaff.map((s) => s.name).join(", ")} to{" "}
              {sheet.shift.name} on {sheet.scope.date} and assign these rooms.
            </p>
          )}
          <button
            disabled={disabled || invalid}
            onClick={() => {
              move(
                {
                  type: "distribute",
                  roomIds: selected,
                  attendantIds: targets,
                  mode,
                },
                shiftStaff.map((s) => s.id),
              );
              setPreview(false);
            }}
          >
            {shiftStaff.length
              ? "Add to Shift & Assign"
              : "Confirm distribution"}
          </button>
        </section>
      )}
    </details>
  );
}
