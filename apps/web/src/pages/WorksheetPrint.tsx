import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import type { Worksheet, WorksheetRoom } from "@hospitality/contracts";
import { workload } from "../worksheet-model";
export default function WorksheetPrint({
  sheet,
  onClose,
}: {
  sheet: Worksheet;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"master" | "attendant">(
    sheet.selfRole === "attendant" ? "attendant" : "master",
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const stale =
    sheet.feed.source === "OHIP" &&
    (sheet.feed.stale ||
      sheet.feed.status !== "synced" ||
      !sheet.feed.syncedAt ||
      now - new Date(sheet.feed.syncedAt).getTime() > 180000);
  const assigned = (id: string) =>
    sheet.rooms.filter((r) => sheet.assignments[r.id] === id);
  const totals = (rooms: WorksheetRoom[]) => {
    const w = workload(rooms, sheet.localProgress);
    return `${w.rooms} rooms · ${w.credits} known credits${w.missingCredits ? " (" + w.missingCredits + " unconfigured)" : ""} · ${w.departure} Departure · ${w.stayover} Stayover · ${w.priority} Priority · ${w.outstanding} outstanding locally`;
  };
  const roomTable = (rooms: WorksheetRoom[]) => (
    <table>
      <thead>
        <tr>
          <th>Room / Floor</th>
          <th>OPERA status / Task</th>
          <th>Credits</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        {rooms.map((r) => (
          <tr key={r.id}>
            <td>
              <strong>{r.id}</strong>
              <br />
              {r.floor || "Floor unavailable"}
              {r.roomType && (
                <>
                  <br />
                  {r.roomType}
                </>
              )}
            </td>
            <td>
              {r.status}
              <br />
              {[
                r.departure ? "Departure" : "",
                r.stayover ? "Stayover" : "",
                r.arrival ? "Arrival" : "",
                r.vip ? "VIP" : "",
                r.priority ? "Priority" : "",
                r.dnd ? "DND" : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              <br />
              {r.tasks.join(", ") || "No task supplied"}
            </td>
            <td>
              {r.credits ?? "—"}
              <br />
              <small>
                {r.creditSource === "OHIP"
                  ? "OHIP"
                  : r.creditSource === "local"
                    ? "Local rule"
                    : "Unconfigured"}
              </small>
            </td>
            <td>
              {r.remarks.join("; ") || "—"}
              <br />
              <small>
                Local progress: {sheet.localProgress[r.id] || "unassigned"}
              </small>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  const header = (subtitle: string) => (
    <>
      <div className="worksheet-print-brand">
        HOUSEKEEPING WORKSHEET · {sheet.feed.source}
        {stale && <strong className="worksheet-print-stale"> · STALE</strong>}
      </div>
      <h1>{sheet.property.name}</h1>
      <p>
        {sheet.scope.date} · {sheet.shift.name} · {subtitle}
      </p>
      <p className="worksheet-print-note">
        Current OPERA snapshot:{" "}
        {sheet.feed.syncedAt
          ? new Date(sheet.feed.syncedAt).toLocaleString()
          : "DEMO / no Oracle sync"}{" "}
        · Local assignments only
      </p>
      <p className="worksheet-print-note">
        Saved assignment revision: {sheet.revision}
        {sheet.savedAt
          ? ` · ${new Date(sheet.savedAt).toLocaleString()}`
          : ""}{" "}
        · Snapshot source: {sheet.feed.source}
      </p>
    </>
  );
  const unassigned = sheet.rooms.filter((r) => !sheet.assignments[r.id]);
  const owner = (r: WorksheetRoom) =>
    sheet.roomSupervisors?.[r.id] ||
    sheet.team[sheet.assignments[r.id]] ||
    null;
  const floorTotals = (rooms: WorksheetRoom[], floorIds: string[] = []) => {
    const floors = [
      ...new Set([
        ...floorIds,
        ...rooms.map((r) => r.floor).filter((f): f is string => !!f),
      ]),
    ];
    return (
      <table className="worksheet-print-floor-totals">
        <thead>
          <tr>
            <th>Floor</th>
            <th>Rooms</th>
            <th>Assigned / Unassigned</th>
            <th>Known credits</th>
          </tr>
        </thead>
        <tbody>
          {floors.map((f) => {
            const list = rooms.filter((r) => r.floor === f),
              w = workload(list);
            const count = list.filter((r) => sheet.assignments[r.id]).length;
            return (
              <tr key={f}>
                <td>{f}</td>
                <td>{w.rooms}</td>
                <td>
                  {count} / {w.rooms - count}
                </td>
                <td>
                  {w.credits}
                  {w.missingCredits
                    ? ` + ${w.missingCredits} unconfigured`
                    : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };
  return createPortal(
    <div
      className="worksheet-preview"
      role="dialog"
      aria-modal="true"
      aria-label="Worksheet print preview"
    >
      <div className="worksheet-preview-toolbar">
        <h2>Print preview · A4 portrait</h2>
        {sheet.selfRole !== "attendant" && (
          <label>
            Report
            <select
              aria-label="Worksheet print mode"
              value={mode}
              onChange={(e) =>
                setMode(e.target.value as "master" | "attendant")
              }
            >
              <option value="master">Supervisor Master Worksheet</option>
              <option value="attendant">Attendant Worksheet</option>
            </select>
          </label>
        )}
        <button
          className="primary"
          disabled={!sheet.feed.available}
          onClick={() => window.print()}
        >
          Print / Save PDF
        </button>
        <button onClick={onClose} autoFocus>
          Close preview
        </button>
      </div>
      <div className="worksheet-print">
        {mode === "master" && sheet.selfRole !== "attendant" && (
          <>
            {sheet.supervisors.map((spv) => {
              const coverage = sheet.rooms.filter((r) => owner(r) === spv.id),
                members = sheet.attendants.filter(
                  (a) => sheet.team[a.id] === spv.id,
                ),
                pending = coverage.filter((r) => !sheet.assignments[r.id]);
              const assignedFloors = sheet.supervisorFloors?.[spv.id] || [
                ...new Set(
                  coverage.map((r) => r.floor).filter((f): f is string => !!f),
                ),
              ];
              return (
                <section
                  className="worksheet-print-page worksheet-print-master"
                  key={spv.id}
                >
                  {header(`Supervisor: ${spv.name}`)}
                  <h2>Supervisor Master Worksheet</h2>
                  <p>Supervisor: {spv.name}</p>
                  <p>
                    Assigned floors:{" "}
                    {assignedFloors.join(", ") || "Room-specific coverage"}
                  </p>
                  <h3>Total per floor</h3>
                  {floorTotals(coverage, assignedFloors)}
                  {members.map((att) => (
                    <div className="worksheet-print-team" key={att.id}>
                      <h3>Attendant: {att.name}</h3>
                      {assigned(att.id).length ? (
                        roomTable(assigned(att.id))
                      ) : (
                        <p>No rooms assigned.</p>
                      )}
                      <p className="worksheet-print-total">
                        Attendant total: {totals(assigned(att.id))}
                      </p>
                    </div>
                  ))}
                  {!members.length && <p>No attendants assigned.</p>}
                  <h3>Unassigned rooms ({pending.length})</h3>
                  {pending.length ? (
                    roomTable(pending)
                  ) : (
                    <p>No unassigned rooms in this supervisor's coverage.</p>
                  )}
                  <p className="worksheet-print-total">
                    Supervisor total ({spv.name}): {totals(coverage)}
                  </p>
                  <p>
                    Assigned workload:{" "}
                    {totals(coverage.filter((r) => sheet.assignments[r.id]))}
                  </p>
                  {coverage.some((r) => sheet.roomExceptions?.[r.id]) && (
                    <p className="worksheet-print-note">
                      Room-specific exceptions:{" "}
                      {coverage
                        .filter((r) => sheet.roomExceptions?.[r.id])
                        .map((r) => r.id)
                        .join(", ")}
                      . Existing attendant work has been retained.
                    </p>
                  )}
                </section>
              );
            })}
            {sheet.manager && (
              <section className="worksheet-print-page">
                {header("No supervisor coverage")}
                <h2>Unassigned Rooms — No Supervisor</h2>
                {roomTable(sheet.rooms.filter((r) => !owner(r)))}
                {floorTotals(sheet.rooms.filter((r) => !owner(r)))}
                <p>{totals(sheet.rooms.filter((r) => !owner(r)))}</p>
                <p>
                  All unassigned rooms: {unassigned.length}. Other unassigned
                  rooms are listed on their supervisor's master sheet.
                </p>
              </section>
            )}
          </>
        )}
        {mode === "attendant" &&
          sheet.supervisors.map((spv) => {
            const attendants = sheet.attendants.filter(
              (a) => sheet.team[a.id] === spv.id,
            );
            const supervisorRooms = sheet.rooms.filter(
              (r) => sheet.team[sheet.assignments[r.id]] === spv.id,
            );
            return attendants.map((att) => (
              <section className="worksheet-print-page" key={att.id}>
                {header(`Supervisor: ${spv.name}`)}
                <h2>Attendant: {att.name}</h2>
                <p className="worksheet-print-report-name">
                  Attendant Worksheet
                </p>
                <p>
                  Floors:{" "}
                  {[
                    ...new Set(
                      assigned(att.id).map((r) => r.floor || "Unavailable"),
                    ),
                  ].join(", ") || "—"}
                </p>
                {assigned(att.id).length ? (
                  roomTable(assigned(att.id))
                ) : (
                  <p>No rooms assigned.</p>
                )}
                <p className="worksheet-print-total">
                  Attendant total: {totals(assigned(att.id))}
                </p>
                <p className="worksheet-print-total">
                  Supervisor total ({spv.name}): {totals(supervisorRooms)}
                </p>
                <p className="worksheet-print-note">
                  A changed OPERA status does not confirm local assignment
                  completion.
                </p>
                <div className="worksheet-print-signatures">
                  <div>
                    Attendant signature
                    <span />
                  </div>
                  <div>
                    Supervisor signature
                    <span />
                  </div>
                  <div>
                    Date / time
                    <span />
                  </div>
                </div>
              </section>
            ));
          })}
        {mode === "attendant" && sheet.manager && (
          <section className="worksheet-print-page">
            {header("Unassigned rooms")}
            <h2>Unassigned rooms ({unassigned.length})</h2>
            {roomTable(unassigned)}
            <p>{totals(unassigned)}</p>
            <p>
              Available attendants without rooms:{" "}
              {sheet.attendants
                .filter(
                  (a) => a.active && a.available && !assigned(a.id).length,
                )
                .map((a) => a.name)
                .join(", ") || "None"}
            </p>
          </section>
        )}
        {mode === "attendant" &&
          !sheet.manager &&
          !sheet.attendants.some((a) => assigned(a.id).length) && (
            <section className="worksheet-print-page">
              {header("No assigned rooms")}
              <p>No rooms assigned.</p>
            </section>
          )}
      </div>
    </div>,
    document.body,
  );
}
