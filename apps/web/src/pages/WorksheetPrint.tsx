import { createPortal } from "react-dom";
import type { Worksheet, WorksheetRoom } from "@hospitality/contracts";
import { workload } from "../worksheet-model";
export default function WorksheetPrint({
  sheet,
  onClose,
}: {
  sheet: Worksheet;
  onClose: () => void;
}) {
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
    </>
  );
  const unassigned = sheet.rooms.filter((r) => !sheet.assignments[r.id]);
  return createPortal(
    <div
      className="worksheet-preview"
      role="dialog"
      aria-modal="true"
      aria-label="Worksheet print preview"
    >
      <div className="worksheet-preview-toolbar">
        <h2>Print preview · A4 portrait</h2>
        <button className="primary" onClick={() => window.print()}>
          Print / Save PDF
        </button>
        <button onClick={onClose} autoFocus>
          Close preview
        </button>
      </div>
      <div className="worksheet-print">
        {sheet.supervisors.map((spv) => {
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
            </section>
          ));
        })}
        {sheet.manager && (
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
        {!sheet.manager &&
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
