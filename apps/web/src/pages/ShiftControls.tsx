import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useData, write } from "../api";
import { browserId } from "../browser-id";
type Shift = {
  id: string;
  name: string;
  starts_at: string;
  ends_at: string;
  active?: boolean;
};
export default function ShiftControls({
  propertyId,
  date,
  shiftId,
  shifts,
  disabled = false,
}: {
  propertyId: string;
  date: string;
  shiftId: string;
  shifts: Shift[];
  disabled?: boolean;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Shift | null>(null);
  const scope = { propertyId, date, shiftId };
  const roster = useData<{
    staff: { id: string; name: string; role: string; available: boolean }[];
  }>(
    ["housekeeping", propertyId, date, shiftId, "roster"],
    "/local-housekeeping/roster?" + new URLSearchParams(scope),
    open && !!shiftId,
  );
  const ids =
    selected ||
    roster.data?.staff.filter((s) => s.available).map((s) => s.id) ||
    [];
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await write("/local-housekeeping/" + path, body, "PUT");
      await client.invalidateQueries({
        queryKey: ["housekeeping", propertyId],
      });
      setOpen(false);
      setSelected(null);
      setEditing(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="worksheet-shift-controls">
      <button
        disabled={disabled || !shiftId || busy}
        onClick={() => {
          setOpen(!open);
          setSelected(null);
          setError("");
        }}
      >
        Manage Shift Staff
      </button>
      <details>
        <summary>Configure shifts</summary>
        <p>
          Local property shifts. End time before start time means next day; the
          selected property business date owns the whole shift.
        </p>
        <select
          aria-label="Edit shift"
          value={editing?.id || ""}
          onChange={(e) =>
            setEditing(shifts.find((s) => s.id === e.target.value) || null)
          }
        >
          <option value="">New shift</option>
          {shifts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.active === false ? " (inactive)" : ""}
            </option>
          ))}
        </select>
        <form
          key={editing?.id || "new"}
          className="worksheet-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void save("shifts", {
              propertyId,
              id: editing?.id || browserId(),
              name: f.get("name"),
              startsAt: f.get("startsAt"),
              endsAt: f.get("endsAt"),
              active: f.get("active") === "on",
            });
          }}
        >
          <label>
            Shift name
            <input
              name="name"
              required
              maxLength={100}
              defaultValue={editing?.name}
            />
          </label>
          <label>
            Start time
            <input
              type="time"
              name="startsAt"
              required
              defaultValue={editing?.starts_at.slice(0, 5)}
            />
          </label>
          <label>
            End time
            <input
              type="time"
              name="endsAt"
              required
              defaultValue={editing?.ends_at.slice(0, 5)}
            />
          </label>
          <label>
            <input
              type="checkbox"
              name="active"
              defaultChecked={editing?.active !== false}
            />
            Active
          </label>
          <button disabled={disabled || busy}>Save shift</button>
        </form>
      </details>
      {error && <p role="alert">{error}</p>}
      {open && (
        <section
          className="worksheet-roster-editor"
          aria-label="Shift staff roster"
        >
          <h3>
            Shift staff · {date} · {shifts.find((s) => s.id === shiftId)?.name}
          </h3>
          <p>
            Only selected staff are scheduled. Existing work must be
            reassigned/released before removing staff.
          </p>
          {roster.error && <p role="alert">{roster.error.message}</p>}
          {["supervisor", "attendant"].map((role) => (
            <fieldset key={role}>
              <legend>
                {role === "supervisor" ? "Supervisors" : "Attendants"}
              </legend>
              {roster.data?.staff
                .filter((s) => s.role === role)
                .map((s) => (
                  <label key={s.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(s.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...ids, s.id]
                            : ids.filter((id) => id !== s.id),
                        )
                      }
                    />
                    {s.name}
                  </label>
                ))}
            </fieldset>
          ))}
          <button
            disabled={busy || !roster.data || disabled}
            onClick={() => void save("roster", { ...scope, userIds: ids })}
          >
            Save shift staff ({ids.length})
          </button>
          <button onClick={() => setOpen(false)}>Cancel</button>
        </section>
      )}
    </div>
  );
}
