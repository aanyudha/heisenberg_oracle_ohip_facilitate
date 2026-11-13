import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "../workspace";
import { useData, write, time } from "../api";
import { State, Badge, Empty } from "../components";

const values = (f: FormData, key: string) =>
  f.getAll(key).map(String).filter(Boolean);
function Multi({
  label,
  name,
  options,
  selected = [],
}: {
  label: string;
  name: string;
  options: { id: string; name: string }[];
  selected?: string[];
}) {
  return (
    <label>
      {label}
      <select
        name={name}
        multiple
        defaultValue={selected}
        aria-label={label}
        size={Math.min(5, Math.max(2, options.length))}
      >
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </select>
      <small>Use Ctrl/Cmd to select multiple items.</small>
    </label>
  );
}
function Workload({ value: w }: { value: any }) {
  return (
    <span>
      {w.rooms} rooms · {w.departure} departure / {w.stayover} stayover ·{" "}
      <b>{w.credits} credits</b> · {w.outstanding} outstanding locally
    </span>
  );
}
export default function Housekeeping() {
  const { user, propertyId, date } = useWorkspace();
  const client = useQueryClient();
  const [shift, setShift] = useState("");
  const [mode, setMode] = useState("briefing");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const setup = useData<any>(
    ["housekeeping", propertyId, "setup"],
    `/local-housekeeping/setup?propertyId=${encodeURIComponent(propertyId)}`,
    !!propertyId,
  );
  const selectedShift = setup.data?.shifts?.some((s: any) => s.id === shift)
    ? shift
    : setup.data?.shifts?.[0]?.id || "";
  const scope = { propertyId, date, shiftId: selectedShift };
  const board = useData<any>(
    ["housekeeping", propertyId, date, selectedShift],
    `/local-housekeeping/board?${new URLSearchParams(scope)}`,
    !!propertyId && !!selectedShift && !!setup.data,
  );
  const b = board.data;
  async function save(path: string, body: unknown, method = "PUT") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await write("/local-housekeeping/" + path, body, method);
      setMessage("Local Housekeeping assignment saved.");
      await client.invalidateQueries({
        queryKey: ["housekeeping", propertyId],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function form(path: string, body: (f: FormData) => unknown) {
    return (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void save(path, body(new FormData(e.currentTarget)));
    };
  }
  const dir = b?.rooms || setup.data?.directory || [];
  const floors = [...new Set<string>(dir.map((r: any) => r.floor))].map(
    (id) => ({ id, name: id }),
  );
  const sections = [
    ...new Set<string>(dir.map((r: any) => r.section).filter(Boolean)),
  ].map((id) => ({ id, name: id }));
  const roomOptions = dir.map((r: any) => ({
    id: r.room_id,
    name: `${r.room_id} · Floor ${r.floor} · ${r.section || "No section"}`,
  }));
  const staff = setup.data?.staff || [];
  return (
    <div className="housekeeping" key={propertyId}>
      <p className="helper">
        Staff assignments and progress are stored locally. OPERA room status
        remains read-only. Business date: {date}.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      <State query={setup}>
        <section className="panel">
          <div className="toolbar">
            <label>
              Shift
              <select
                aria-label="Housekeeping shift"
                value={selectedShift}
                onChange={(e) => {
                  setShift(e.target.value);
                  setError("");
                  setMessage("");
                }}
              >
                {setup.data?.shifts?.map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.starts_at}–{s.ends_at})
                  </option>
                ))}
              </select>
            </label>
            <label>
              View
              <select
                aria-label="Housekeeping view"
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="briefing">Morning briefing</option>
                <option value="end">End of shift</option>
              </select>
            </label>
          </div>
          {!selectedShift && (
            <Empty text="Configure a shift, registered staff and validated room mapping to begin." />
          )}
          {selectedShift && (
            <State query={board}>
              <h2>
                {mode === "briefing" ? "Morning briefing" : "End of shift"}
              </h2>
              <p>
                {b?.source} · Last OHIP synchronization: {time(b?.lastOhipSync)}{" "}
                · Connection: {b?.connectionStatus}
              </p>
              <p className="helper">{b?.snapshotNotice}</p>
              {b && (
                <p>
                  <Workload value={b.workload} />
                </p>
              )}
              {b?.warnings.map((w: string) => (
                <p role="alert" className="form-error" key={w}>
                  {w}
                </p>
              ))}
              {b?.supervisors.map((s: any) => (
                <article className="hk-team" key={s.supervisor_id}>
                  <h3>{s.name}</h3>
                  <p>
                    Floors: {s.floors.join(", ") || "—"} · Specific rooms:{" "}
                    {s.rooms.join(", ") || "—"}
                  </p>
                  <p>Coverage: {s.coverage.join(", ") || "None"}</p>
                  <p>
                    <Workload value={s.workload} />
                  </p>
                  {mode === "end" && (
                    <p>
                      OPERA snapshot: {s.workload.dirty} Dirty ·{" "}
                      {s.workload.clean} Clean · {s.workload.inspected}{" "}
                      Inspected · {s.workload.discrepancies} PMR/DND /
                      discrepancies
                    </p>
                  )}
                  {s.attendants.length === 0 && <p>No attendants assigned.</p>}
                  {s.attendants.map((a: any) => (
                    <div key={a.attendant_id}>
                      <b>{a.name}</b>
                      {b.canManage && a.workload.rooms > 0 && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void save("attendants", {
                              ...scope,
                              attendantId: a.attendant_id,
                              supervisorId: a.supervisor_id,
                              rooms: [],
                              floors: [],
                              sections: [],
                            })
                          }
                        >
                          Release local rooms for {a.name}
                        </button>
                      )}
                      {!a.eligible && (
                        <Badge tone="amber">Staff review required</Badge>
                      )}
                      <p>
                        <Workload value={a.workload} />
                      </p>
                      <p>
                        Floors: {a.floors.join(", ") || "—"} · Sections:{" "}
                        {a.sections.join(", ") || "—"}
                      </p>
                      <p>
                        Rooms:{" "}
                        {b.rooms
                          .filter(
                            (r: any) =>
                              r.assignment?.attendant_id === a.attendant_id,
                          )
                          .map((r: any) => r.room_id)
                          .join(", ") || "None"}
                      </p>
                    </div>
                  ))}
                  {b.manager && (
                    <details>
                      <summary>Edit supervisor coverage</summary>
                      <form
                        onSubmit={form("supervisors", (f) => ({
                          ...scope,
                          supervisorId: s.supervisor_id,
                          floors: values(f, "floors"),
                          rooms: values(f, "rooms"),
                        }))}
                      >
                        <Multi
                          label={`Floors for ${s.name}`}
                          name="floors"
                          options={floors}
                          selected={s.floors}
                        />
                        <Multi
                          label={`Specific rooms for ${s.name}`}
                          name="rooms"
                          options={roomOptions}
                          selected={s.rooms}
                        />
                        <button disabled={busy}>Save coverage</button>
                      </form>
                    </details>
                  )}
                </article>
              ))}
              {b?.supervisors.length === 0 && (
                <Empty text="No supervisor coverage for this date and shift." />
              )}
              <p>Unassigned rooms: {b?.unassignedRooms.join(", ") || "None"}</p>
              {b?.manager && (
                <>
                  <p>
                    Unassigned available attendants:{" "}
                    {b.unassignedAvailableAttendants
                      .map((r: any) => r.name)
                      .join(", ") || "None"}
                  </p>
                  <p>
                    Rooms requiring validated floor/section mapping:{" "}
                    {b.unmappedRooms.map((r: any) => r.id).join(", ") || "None"}
                  </p>
                </>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Room / location</th>
                      <th>Workload</th>
                      <th>OPERA snapshot</th>
                      <th>Local assignment</th>
                      {mode === "end" && <th>Snapshot comparison</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {b?.rooms.map((r: any) => (
                      <tr key={r.room_id}>
                        <td>
                          {r.room_id}
                          <small>
                            Floor {r.floor} · {r.section || "No section"}
                          </small>
                        </td>
                        <td>
                          {r.kind}
                          <small>{r.credits} credits</small>
                        </td>
                        <td>
                          {r.status}
                          <small>{r.attention || "No attention flag"}</small>
                          <small>{time(r.updated_at)}</small>
                        </td>
                        <td>
                          {r.assignment ? (
                            <>
                              {
                                b.attendants.find(
                                  (a: any) =>
                                    a.attendant_id ===
                                    r.assignment.attendant_id,
                                )?.name
                              }
                              <small>{r.assignment.local_status}</small>
                              {b.canManage && (
                                <select
                                  aria-label={`Local progress ${r.room_id}`}
                                  value={r.assignment.local_status}
                                  disabled={busy}
                                  onChange={(e) =>
                                    void save(
                                      `progress/${r.assignment.id}`,
                                      { ...scope, status: e.target.value },
                                      "PATCH",
                                    )
                                  }
                                >
                                  <option value="assigned">
                                    Assigned locally
                                  </option>
                                  <option value="in_progress">
                                    In progress locally
                                  </option>
                                  <option value="completed">
                                    Completed locally
                                  </option>
                                </select>
                              )}
                            </>
                          ) : (
                            "Unassigned"
                          )}
                        </td>
                        {mode === "end" && (
                          <td>
                            {r.assignment ? (
                              <>
                                {r.assignment.baseline_status} → {r.status}
                                <small>
                                  {r.snapshotChanged
                                    ? "Snapshot changed; completion not inferred"
                                    : "No snapshot change"}
                                </small>
                                <small>
                                  Baseline: {time(r.assignment.baseline_at)}
                                </small>
                                {r.assignment.baseline_attention && (
                                  <small>
                                    Baseline attention:{" "}
                                    {r.assignment.baseline_attention}
                                  </small>
                                )}
                              </>
                            ) : (
                              "No baseline"
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </State>
          )}
        </section>
        {setup.data?.manager && (
          <details className="panel">
            <summary>Housekeeping setup</summary>
            <div className="hk-forms">
              <p>Staff roles are managed in Administration → Users & Roles.</p>
              <form
                onSubmit={form("shifts", (f) => ({
                  propertyId,
                  id: f.get("id"),
                  name: f.get("name"),
                  startsAt: f.get("startsAt"),
                  endsAt: f.get("endsAt"),
                }))}
              >
                <h3>Shift</h3>
                <label>
                  Shift code
                  <input name="id" required maxLength={100} />
                </label>
                <label>
                  Shift name
                  <input name="name" required maxLength={100} />
                </label>
                <label>
                  Start time
                  <input type="time" name="startsAt" required />
                </label>
                <label>
                  End time
                  <input type="time" name="endsAt" required />
                </label>
                <button disabled={busy}>Save shift</button>
              </form>
              <form
                onSubmit={form("directory", (f) => ({
                  propertyId,
                  roomId: f.get("roomId"),
                  floor: f.get("floor"),
                  section: f.get("section"),
                  departureCredits: Number(f.get("departureCredits")),
                  stayoverCredits: Number(f.get("stayoverCredits")),
                  otherCredits: Number(f.get("otherCredits")),
                  validated: f.get("validated") === "on",
                }))}
              >
                <h3>Validate property room mapping</h3>
                <label>
                  Verified property room
                  <input
                    name="roomId"
                    list="hk-snapshot-rooms"
                    required
                    maxLength={100}
                  />
                  <datalist id="hk-snapshot-rooms">
                    {setup.data.rooms.map((r: any) => (
                      <option key={r.id} value={r.id} />
                    ))}
                  </datalist>
                  <small>
                    Use a snapshot room or enter a room verified against the
                    property directory. Missing OPERA status stays Unknown.
                  </small>
                </label>
                <label>
                  Verified floor
                  <input name="floor" required maxLength={100} />
                </label>
                <label>
                  Section
                  <input name="section" maxLength={100} />
                </label>
                {["departure", "stayover", "other"].map((k) => (
                  <label key={k}>
                    {k} credits
                    <input
                      type="number"
                      name={k + "Credits"}
                      min="0"
                      max="9999"
                      step="0.01"
                      defaultValue={k === "other" ? 0 : 1}
                      required
                    />
                  </label>
                ))}
                <label>
                  <input type="checkbox" name="validated" required /> I verified
                  this property room mapping
                </label>
                <button disabled={busy}>Save validated mapping</button>
              </form>
            </div>
          </details>
        )}
        {selectedShift && b?.manager && (
          <details className="panel">
            <summary>Schedule and supervisor assignment</summary>
            <div className="hk-forms">
              <form
                onSubmit={form("schedules", (f) => ({
                  ...scope,
                  userId: f.get("userId"),
                  available: f.get("available") === "true",
                }))}
              >
                <h3>Staff availability · {date}</h3>
                <label>
                  Staff
                  <select name="userId" required>
                    {staff.map((s: any) => (
                      <option key={s.user_id} value={s.user_id}>
                        {s.name} ({s.job_role})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Availability
                  <select name="available">
                    <option value="true">Available</option>
                    <option value="false">Unavailable</option>
                  </select>
                </label>
                <button disabled={busy}>Save availability</button>
                <p>
                  {b.schedules
                    .map(
                      (s: any) =>
                        `${staff.find((t: any) => t.user_id === s.user_id)?.name || s.user_id}: ${s.available ? "available" : "unavailable"}`,
                    )
                    .join(" · ") || "No staff scheduled"}
                </p>
              </form>
              <form
                onSubmit={form("supervisors", (f) => ({
                  ...scope,
                  supervisorId: f.get("supervisorId"),
                  floors: values(f, "floors"),
                  rooms: values(f, "rooms"),
                }))}
              >
                <h3>Assign supervisor coverage</h3>
                <label>
                  Supervisor
                  <select
                    name="supervisorId"
                    aria-label="Supervisor coverage staff"
                    required
                  >
                    {staff
                      .filter(
                        (s: any) =>
                          s.job_role === "supervisor" &&
                          b.schedules.some(
                            (t: any) => t.user_id === s.user_id && t.available,
                          ),
                      )
                      .map((s: any) => (
                        <option key={s.user_id} value={s.user_id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <Multi
                  label="Supervisor floors"
                  name="floors"
                  options={floors}
                />
                <Multi
                  label="Supervisor specific rooms"
                  name="rooms"
                  options={roomOptions}
                />
                <button disabled={busy}>Save supervisor coverage</button>
              </form>
            </div>
          </details>
        )}
        {selectedShift && b?.canManage && (
          <details className="panel">
            <summary>Assign or move attendant rooms</summary>
            <p>
              Saving replaces this attendant's room selection. Empty selections
              release rooms. Release source rooms before moving coverage to
              another supervisor.
            </p>
            <form
              className="hk-assignment-form"
              key={`${propertyId}-${date}-${selectedShift}`}
              onSubmit={form("attendants", (f) => ({
                ...scope,
                attendantId: f.get("attendantId"),
                supervisorId: f.get("supervisorId"),
                floors: values(f, "floors"),
                sections: values(f, "sections"),
                rooms: values(f, "rooms"),
              }))}
            >
              <label>
                Attendant
                <select name="attendantId" required>
                  {b.assignableStaff.map((s: any) => (
                    <option key={s.user_id} value={s.user_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Under supervisor
                <select
                  name="supervisorId"
                  aria-label="Under supervisor"
                  required
                >
                  {b.supervisors
                    .filter(
                      (s: any) => b.manager || s.supervisor_id === user.id,
                    )
                    .map((s: any) => (
                      <option key={s.supervisor_id} value={s.supervisor_id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </label>
              <Multi label="Attendant floors" name="floors" options={floors} />
              <Multi
                label="Attendant sections"
                name="sections"
                options={sections}
              />
              <Multi
                label="Attendant rooms"
                name="rooms"
                options={roomOptions}
              />
              <button disabled={busy}>Save attendant assignment</button>
            </form>
          </details>
        )}
      </State>
    </div>
  );
}
