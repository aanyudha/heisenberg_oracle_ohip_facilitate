import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Printer,
  Undo2,
  GripVertical,
  Users,
  DoorOpen,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import type {
  Worksheet,
  WorksheetRoom,
  WorksheetOperation,
} from "@hospitality/contracts";
import { useWorkspace } from "../workspace";
import { useData, time } from "../api";
import { State, Empty, Badge } from "../components";
import { useWorksheetAutosave } from "../useWorksheetAutosave";
import { workload } from "../worksheet-model";
import WorksheetPrint from "./WorksheetPrint";
import FloorAssignment from "./FloorAssignment";
import "./HousekeepingWorksheet.css";

type Setup = {
  selfRole: string | null;
  manager: boolean;
  shifts: { id: string; name: string; starts_at: string; ends_at: string }[];
};
export default function HousekeepingWorksheet() {
  const { propertyId, date } = useWorkspace();
  const [shift, setShift] = useState("");
  const setup = useData<Setup>(
    ["housekeeping", propertyId, "setup"],
    `/local-housekeeping/setup?propertyId=${encodeURIComponent(propertyId)}`,
  );
  const selected = setup.data?.shifts?.some((s) => s.id === shift)
    ? shift
    : setup.data?.shifts?.[0]?.id || "";
  return (
    <div className="worksheet-root">
      <State query={setup}>
        {selected ? (
          <WorksheetBoard
            key={`${propertyId}-${date}-${selected}`}
            shiftId={selected}
            shifts={setup.data?.shifts || []}
            setShift={setShift}
          />
        ) : (
          <section className="worksheet-empty">
            <DoorOpen size={32} />
            <h2>Housekeeping Worksheet</h2>
            <p>No local shift is configured for this property.</p>
            {setup.data?.manager && (
              <Link to="/operations/rooms-settings">
                Open Housekeeping configuration
              </Link>
            )}
          </section>
        )}
      </State>
    </div>
  );
}
function WorksheetBoard({
  shiftId,
  shifts,
  setShift,
}: {
  shiftId: string;
  shifts: Setup["shifts"];
  setShift: (id: string) => void;
}) {
  const { propertyId, date, user } = useWorkspace();
  const query = useData<Worksheet>(
    ["housekeeping", propertyId, date, shiftId, "worksheet"],
    `/local-housekeeping/worksheet?${new URLSearchParams({ propertyId, date, shiftId })}`,
  );
  const { sheet, move, undo, pending, saving, error, canUndo } =
    useWorksheetAutosave(query.data);
  const [selected, setSelected] = useState<string[]>([]),
    [floor, setFloor] = useState(""),
    [status, setStatus] = useState(""),
    [roomType, setRoomType] = useState(""),
    [target, setTarget] = useState(""),
    [exceptionTarget, setExceptionTarget] = useState(""),
    [preview, setPreview] = useState(false);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const eligible =
    sheet?.attendants.filter(
      (a) =>
        a.active &&
        a.available &&
        ((sheet.team[a.id] &&
          sheet.supervisors.some(
            (s) => s.id === sheet.team[a.id] && s.active && s.available,
          )) ||
          (!sheet.manager &&
            sheet.selfRole === "supervisor" &&
            !sheet.team[a.id] &&
            sheet.canManage)),
    ) || [];
  const assigned = (uid: string) =>
    sheet?.rooms.filter((r) => sheet.assignments[r.id] === uid) || [];
  const filtered = (r: WorksheetRoom) =>
    (!floor || r.floor === floor) &&
    (!roomType || r.roomType === roomType) &&
    (!status ||
      (["Departure", "Stayover", "Arrival", "VIP", "DND", "Priority"].includes(
        status,
      )
        ? (
            {
              Departure: r.departure,
              Stayover: r.stayover,
              Arrival: r.arrival,
              VIP: r.vip,
              DND: r.dnd,
              Priority: r.priority,
            } as Record<string, boolean>
          )[status]
        : r.status === status));
  const change = (op: WorksheetOperation) => {
    if (
      op.type === "rooms" &&
      op.attendantId &&
      sheet?.selfRole === "supervisor" &&
      !sheet.team[op.attendantId]
    )
      move({
        type: "team",
        attendantId: op.attendantId,
        supervisorId: user.id,
      });
    move(op);
    setSelected([]);
  };
  function roomDrop(event: React.DragEvent, attendantId: string | null) {
    event.preventDefault();
    event.stopPropagation();
    setDragOver(null);
    try {
      const ids = JSON.parse(
        event.dataTransfer.getData("application/x-housekeeping-rooms"),
      );
      if (
        Array.isArray(ids) &&
        ids.length &&
        ids.every(
          (id) =>
            typeof id === "string" && sheet?.rooms.some((r) => r.id === id),
        )
      )
        change({
          type: "rooms",
          roomIds: [...new Set<string>(ids)],
          attendantId,
        });
    } catch {
      /* Ignore unrelated drops. */
    }
  }
  function teamDrop(event: React.DragEvent, supervisorId: string) {
    event.preventDefault();
    setDragOver(null);
    const attendantId = event.dataTransfer.getData(
      "application/x-housekeeping-attendant",
    );
    if (sheet?.manager && sheet.attendants.some((a) => a.id === attendantId))
      change({ type: "team", attendantId, supervisorId });
  }
  const metrics = (rooms: WorksheetRoom[], compact = false) => {
    const w = workload(rooms, sheet?.localProgress);
    return (
      <div
        className={
          compact ? "worksheet-workload compact" : "worksheet-workload"
        }
      >
        <span>
          <strong>{w.rooms}</strong> rooms
        </span>
        <span>
          <strong>{w.credits}</strong> credits
          {w.missingCredits > 0 ? " + unconfigured" : ""}
        </span>
        <span>
          {w.departure} Departure · {w.stayover} Stayover · {w.priority}{" "}
          Priority
        </span>
        {compact && <span>{w.outstanding} outstanding locally</span>}
      </div>
    );
  };
  const roomCard = (r: WorksheetRoom) => (
    <article
      key={r.id}
      data-room-id={r.id}
      className={`worksheet-room ${selected.includes(r.id) ? "selected" : ""} status-${r.status.toLowerCase()}`}
      draggable={!!sheet?.canManage && !!sheet?.feed.available}
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          "application/x-housekeeping-rooms",
          JSON.stringify(selected.includes(r.id) ? selected : [r.id]),
        );
      }}
      aria-label={`Room ${r.id}`}
    >
      <div className="worksheet-room-top">
        <div>
          {sheet?.canManage && (
            <input
              type="checkbox"
              aria-label={`Select room ${r.id}`}
              checked={selected.includes(r.id)}
              onChange={(e) =>
                setSelected((ids) =>
                  e.target.checked
                    ? [...ids, r.id]
                    : ids.filter((id) => id !== r.id),
                )
              }
            />
          )}
          <strong>{r.id}</strong>
        </div>
        <Badge
          tone={
            r.status === "Inspected"
              ? "green"
              : r.outOfOrder || r.outOfService
                ? "rose"
                : r.status === "Dirty"
                  ? "amber"
                  : ""
          }
        >
          {r.status === "OutOfOrder"
            ? "OOO"
            : r.status === "OutOfService"
              ? "OOS"
              : r.status}
        </Badge>
      </div>
      <div className="worksheet-room-location">
        {r.floor ? `Floor ${r.floor}` : "Floor unavailable"}
        {r.roomType ? ` · ${r.roomType}` : ""}
      </div>
      <div className="worksheet-room-tags">
        {r.departure && <span className="departure">Departure</span>}
        {r.stayover && <span>Stayover</span>}
        {r.arrival && <span>Arrival</span>}
        {r.vip && <span className="vip">VIP</span>}
        {r.dnd && <span className="dnd">DND</span>}
        {r.makeUpRoom && <span>Make Up Room</span>}
        {r.priority && <span>Priority</span>}
      </div>
      <p className="worksheet-room-task">
        {r.tasks.join(" · ") || "No task supplied"}
        {r.remarks.length > 0 && <small>{r.remarks.join(" · ")}</small>}
      </p>
      <div className="worksheet-room-bottom">
        <span>
          {r.credits === null ? "Credits unconfigured" : `${r.credits} credits`}{" "}
          <small>
            {r.creditSource === "OHIP"
              ? "OHIP"
              : r.creditSource === "local"
                ? "Local rule"
                : ""}
          </small>
        </span>
        {sheet?.assignments[r.id] && (
          <small>Local: {sheet.localProgress[r.id] || "assigned"}</small>
        )}
      </div>
      {sheet?.canManage && (
        <select
          className="worksheet-assign-to"
          aria-label={`Assign room ${r.id} to`}
          disabled={!sheet.feed.available}
          value={sheet.assignments[r.id] || ""}
          onChange={(e) =>
            change({
              type: "rooms",
              roomIds: [r.id],
              attendantId: e.target.value || null,
            })
          }
        >
          <option value="">Unassigned</option>
          {sheet.assignments[r.id] &&
            !eligible.some((a) => a.id === sheet.assignments[r.id]) && (
              <option value={sheet.assignments[r.id]} disabled>
                {sheet.attendants.find((a) => a.id === sheet.assignments[r.id])
                  ?.name || "Assigned staff"}{" "}
                (unavailable)
              </option>
            )}
          {eligible.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
    </article>
  );
  const attendantCard = (id: string, compact = false) => {
    const att = sheet!.attendants.find((a) => a.id === id)!;
    const rooms = assigned(id);
    return (
      <section
        key={id}
        className={`worksheet-attendant ${compact ? "compact-roster" : ""} ${dragOver === id ? "drop-active" : ""}`}
        data-attendant-id={id}
        onDragOver={(event) => {
          if (
            sheet?.canManage &&
            eligible.some((a) => a.id === id) &&
            event.dataTransfer.types.includes(
              "application/x-housekeeping-rooms",
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            setDragOver(id);
          }
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(event) => roomDrop(event, id)}
      >
        <header
          className="worksheet-attendant-header"
          draggable={sheet?.manager && att.active && att.available}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(
              "application/x-housekeeping-attendant",
              id,
            );
          }}
        >
          <div>
            <GripVertical size={16} />
            <h3>{att.name}</h3>
            {(!att.active || !att.available) && (
              <Badge tone="amber">Unavailable</Badge>
            )}
          </div>
          {sheet?.manager && (
            <select
              aria-label={`Supervisor for ${att.name}`}
              value={sheet.team[id] || ""}
              disabled={!att.active || !att.available}
              onChange={(e) =>
                e.target.value &&
                change({
                  type: "team",
                  attendantId: id,
                  supervisorId: e.target.value,
                })
              }
            >
              <option value="" disabled>
                Choose supervisor
              </option>
              {sheet.supervisors
                .filter((s) => s.active && s.available)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          )}
          {!sheet?.manager &&
            sheet?.selfRole === "supervisor" &&
            sheet.canManage &&
            !sheet.team[id] && (
              <button
                disabled={!att.active || !att.available}
                onClick={() =>
                  change({
                    type: "team",
                    attendantId: id,
                    supervisorId: user.id,
                  })
                }
              >
                Add {att.name} to My Team
              </button>
            )}
          {!compact && metrics(rooms, true)}
        </header>
        {!compact && (
          <div className="worksheet-attendant-rooms">
            {rooms.filter(filtered).map(roomCard)}
            {!rooms.length && (
              <p className="worksheet-drop-hint">
                {sheet?.canManage
                  ? "Drop rooms here or use Assign To."
                  : "No rooms assigned."}
              </p>
            )}
          </div>
        )}
      </section>
    );
  };
  return (
    <State query={query}>
      {sheet && (
        <>
          <header className="worksheet-heading">
            <div>
              <p className="eyebrow">HOUSEKEEPING · LOCAL ASSIGNMENT</p>
              <h1>
                {sheet.selfRole === "attendant"
                  ? "My Worksheet"
                  : sheet.selfRole === "supervisor"
                    ? "My Team"
                    : "Housekeeping Worksheet"}
              </h1>
              <p>
                {sheet.property.name} · {date}{" "}
                <span className="worksheet-source">{sheet.feed.source}</span>
              </p>
            </div>
            <div className="worksheet-actions">
              {sheet.canManage && (
                <button onClick={() => void undo()} disabled={!canUndo}>
                  <Undo2 size={16} /> Undo last move
                </button>
              )}
              <button
                className="primary"
                disabled={pending || saving || !sheet.feed.available}
                onClick={() => setPreview(true)}
              >
                <Printer size={16} /> Print Worksheet
              </button>
            </div>
          </header>
          <div className="worksheet-context">
            <label>
              Shift
              <select
                aria-label="Housekeeping shift"
                value={shiftId}
                disabled={pending || saving}
                onChange={(e) => setShift(e.target.value)}
              >
                {shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.starts_at.slice(0, 5)}–{s.ends_at.slice(0, 5)}
                  </option>
                ))}
              </select>
            </label>
            <span>
              Last OHIP sync
              <strong>
                {sheet.feed.source === "DEMO"
                  ? "DEMO — no Oracle sync"
                  : sheet.feed.syncedAt
                    ? time(sheet.feed.syncedAt)
                    : "Unavailable"}
              </strong>
            </span>
            <span className="worksheet-save-state" role="status">
              {error ? (
                "Save error — review the message below"
              ) : saving ? (
                "Saving locally…"
              ) : pending ? (
                "Unsaved local changes…"
              ) : (
                <>
                  <CheckCircle2 size={16} /> All local changes saved
                </>
              )}
            </span>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {sheet.warnings.map((w) => (
            <p role="alert" className="worksheet-warning" key={w}>
              <AlertCircle size={16} />
              {w}
            </p>
          ))}
          {sheet.feed.taskError && (
            <p className="worksheet-warning">{sheet.feed.taskError}</p>
          )}
          {sheet.missingAssignedRooms > 0 && (
            <p className="worksheet-warning">
              {sheet.missingAssignedRooms} locally assigned rooms are absent
              from the current authorized feed. Assignments are retained; room
              details are not fabricated.
            </p>
          )}
          {!sheet.feed.available ? (
            <section className="worksheet-empty">
              <DoorOpen size={32} />
              <h2>OPERA room data unavailable</h2>
              <p>
                {sheet.feed.error ||
                  "OPERA has not provided any housekeeping rooms for this property."}
              </p>
              <p>
                Local assignments are retained. No synthetic live room list is
                shown.
              </p>
              <button onClick={() => void query.refetch()}>
                Check room feed
              </button>
            </section>
          ) : (
            <>
              {(sheet.manager || sheet.selfRole === "supervisor") && (
                <FloorAssignment sheet={sheet} move={change} />
              )}
              <div className="worksheet-summary">
                <div>
                  <span>Total rooms</span>
                  <strong>{sheet.rooms.length}</strong>
                </div>
                <div>
                  <span>Unassigned</span>
                  <strong>
                    {sheet.rooms.filter((r) => !sheet.assignments[r.id]).length}
                  </strong>
                </div>
                <div>
                  <span>Departure / Stayover</span>
                  <strong>
                    {sheet.rooms.filter((r) => r.departure).length} /{" "}
                    {sheet.rooms.filter((r) => r.stayover).length}
                  </strong>
                </div>
                <div>
                  <span>Priority</span>
                  <strong>
                    {sheet.rooms.filter((r) => r.priority).length}
                  </strong>
                </div>
                {sheet.selfRole === "supervisor" && (
                  <>
                    <div>
                      <span>Assigned Rooms</span>
                      <strong>
                        {
                          sheet.rooms.filter((r) => sheet.assignments[r.id])
                            .length
                        }
                      </strong>
                    </div>
                    <div>
                      <span>Total Credits</span>
                      <strong>
                        {
                          workload(
                            sheet.rooms.filter((r) => sheet.assignments[r.id]),
                          ).credits
                        }
                      </strong>
                    </div>
                  </>
                )}
              </div>
              <div className="worksheet-toolbar">
                <label>
                  Floor
                  <select
                    aria-label="Filter floor"
                    value={floor}
                    onChange={(e) => setFloor(e.target.value)}
                  >
                    <option value="">All floors</option>
                    {[
                      ...new Set(
                        sheet.rooms.map((r) => r.floor).filter(Boolean),
                      ),
                    ].map((f) => (
                      <option key={f} value={f!}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Status
                  <select
                    aria-label="Filter room status"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="">All statuses</option>
                    {[
                      "Departure",
                      "Stayover",
                      "Arrival",
                      "VIP",
                      "Dirty",
                      "Clean",
                      "Inspected",
                      "DND",
                      "OutOfOrder",
                      "OutOfService",
                      "Priority",
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s === "OutOfOrder"
                          ? "OOO"
                          : s === "OutOfService"
                            ? "OOS"
                            : s}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Room type
                  <select
                    aria-label="Filter room type"
                    value={roomType}
                    onChange={(e) => setRoomType(e.target.value)}
                  >
                    <option value="">All room types</option>
                    {[
                      ...new Set(
                        sheet.rooms.map((r) => r.roomType).filter(Boolean),
                      ),
                    ].map((t) => (
                      <option key={t} value={t!}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                {sheet.canManage && (
                  <label className="worksheet-select-all">
                    <input
                      type="checkbox"
                      aria-label="Select all filtered rooms"
                      checked={
                        !!sheet.rooms.filter(filtered).length &&
                        sheet.rooms
                          .filter(filtered)
                          .every((r) => selected.includes(r.id))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? sheet.rooms.filter(filtered).map((r) => r.id)
                            : [],
                        )
                      }
                    />
                    Select visible rooms
                  </label>
                )}
              </div>
              {sheet.canManage && selected.length > 0 && (
                <div className="worksheet-batch">
                  <strong>{selected.length} rooms selected</strong>
                  <select
                    aria-label="Batch assign to"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">Choose attendant</option>
                    <option value="unassigned">Unassigned rooms</option>
                    {eligible.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                  <button
                    disabled={!target}
                    onClick={() =>
                      change({
                        type: "rooms",
                        roomIds: selected,
                        attendantId: target === "unassigned" ? null : target,
                      })
                    }
                  >
                    Assign selected <ArrowRight size={16} />
                  </button>
                  <button onClick={() => setSelected([])}>
                    Clear selection
                  </button>
                  {sheet.manager && (
                    <details className="worksheet-exception-tools">
                      <summary>Room-specific supervisor exception</summary>
                      <select
                        aria-label="Room exception supervisor"
                        value={exceptionTarget}
                        onChange={(e) => setExceptionTarget(e.target.value)}
                      >
                        <option value="">Choose supervisor</option>
                        <option value="primary">
                          Use primary floor supervisor
                        </option>
                        {sheet.supervisors
                          .filter((s) => s.active && s.available)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                      <button
                        disabled={!exceptionTarget}
                        onClick={() =>
                          change({
                            type: "coverage",
                            roomIds: selected,
                            supervisorId:
                              exceptionTarget === "primary"
                                ? null
                                : exceptionTarget,
                          })
                        }
                      >
                        Apply room exception
                      </button>
                      <small>
                        Existing assigned work remains with its team. Move the
                        room or attendant first to change its supervisor.
                      </small>
                    </details>
                  )}
                </div>
              )}
              <div
                className={`worksheet-board ${sheet.selfRole === "attendant" ? "worksheet-my-rooms" : ""}`}
              >
                {sheet.selfRole !== "attendant" && (
                  <section
                    className={`worksheet-unassigned ${dragOver === "unassigned" ? "drop-active" : ""}`}
                    onDragOver={(e) => {
                      if (
                        sheet.canManage &&
                        e.dataTransfer.types.includes(
                          "application/x-housekeeping-rooms",
                        )
                      ) {
                        e.preventDefault();
                        setDragOver("unassigned");
                      }
                    }}
                    onDrop={(e) => roomDrop(e, null)}
                    data-drop-unassigned
                  >
                    <header>
                      <h2>Unassigned Rooms</h2>
                      <span>
                        {
                          sheet.rooms.filter((r) => !sheet.assignments[r.id])
                            .length
                        }
                      </span>
                    </header>
                    <p>Drag rooms to an attendant. OPERA remains read-only.</p>
                    <div>
                      {sheet.rooms
                        .filter((r) => !sheet.assignments[r.id] && filtered(r))
                        .map(roomCard)}
                      {!sheet.rooms.some(
                        (r) => !sheet.assignments[r.id] && filtered(r),
                      ) && (
                        <p className="worksheet-drop-hint">
                          No unassigned rooms match your filters.
                        </p>
                      )}
                    </div>
                  </section>
                )}
                <div className="worksheet-supervisors">
                  {sheet.canManage &&
                    sheet.attendants.some((a) => !sheet.team[a.id]) && (
                      <section className="worksheet-roster">
                        <h2>Available Attendants</h2>
                        <p>
                          {sheet.manager
                            ? "Drag into a supervisor group, or choose a supervisor."
                            : "Choose an available registered attendant, or drop a room onto their card to add them to My Team."}
                        </p>
                        <div>
                          {sheet.attendants
                            .filter((a) => !sheet.team[a.id])
                            .map((a) => attendantCard(a.id, true))}
                        </div>
                      </section>
                    )}
                  {sheet.supervisors.map((spv) => (
                    <section
                      key={spv.id}
                      className={`worksheet-supervisor ${dragOver === spv.id ? "drop-active" : ""}`}
                      data-supervisor-id={spv.id}
                      onDragOver={(e) => {
                        if (
                          sheet.manager &&
                          e.dataTransfer.types.includes(
                            "application/x-housekeeping-attendant",
                          )
                        ) {
                          e.preventDefault();
                          setDragOver(spv.id);
                        }
                      }}
                      onDrop={(e) => teamDrop(e, spv.id)}
                    >
                      <header>
                        <div>
                          <Users size={19} />
                          <h2>
                            {sheet.selfRole === "supervisor"
                              ? "My Attendants"
                              : spv.name}
                          </h2>
                        </div>
                        {sheet.selfRole === "supervisor" && <p>{spv.name}</p>}
                        <p className="worksheet-scope-label">
                          Assigned floors:{" "}
                          {sheet.supervisorFloors?.[spv.id]?.join(", ") ||
                            "Room-specific coverage"}
                        </p>
                        {metrics(
                          sheet.rooms.filter(
                            (r) =>
                              sheet.team[sheet.assignments[r.id]] === spv.id,
                          ),
                          true,
                        )}
                      </header>
                      {sheet.attendants
                        .filter((a) => sheet.team[a.id] === spv.id)
                        .map((a) => attendantCard(a.id))}
                      {!sheet.attendants.some(
                        (a) => sheet.team[a.id] === spv.id,
                      ) && (
                        <p className="worksheet-drop-hint">
                          {sheet.manager
                            ? "Drop a registered attendant here."
                            : "No attendants in this team."}
                        </p>
                      )}
                    </section>
                  ))}
                </div>
              </div>
              {!sheet.supervisors.length && (
                <Empty text="No registered Housekeeping supervisor with valid property membership is available." />
              )}
              <p className="worksheet-footnote">
                Current OPERA room status is read-only. Local completion is
                independent of Dirty / Clean / Inspected. Credits are labeled
                OHIP or Local rule; unconfigured credits are not guessed.
              </p>
            </>
          )}
          {sheet.manager && (
            <p className="worksheet-configuration">
              <Link to="/operations/rooms-settings">
                Housekeeping configuration
              </Link>
            </p>
          )}
          {preview && (
            <WorksheetPrint sheet={sheet} onClose={() => setPreview(false)} />
          )}
        </>
      )}
    </State>
  );
}
