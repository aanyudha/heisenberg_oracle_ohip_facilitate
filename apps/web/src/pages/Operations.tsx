import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Search, X, ArrowUpRight } from "lucide-react";
import type { Reservation, Task } from "@hospitality/contracts";
import { canGuests } from "@hospitality/contracts";
import { useWorkspace } from "../workspace";
import { useData, time } from "../api";
import { Badge, Empty, Heading, Pager, State } from "../components";
export function ReservationTable({
  items,
  onSelect,
}: {
  items: Reservation[];
  onSelect: (id: string) => void;
}) {
  return !items.length ? (
    <Empty text="No reservations match your filters." />
  ) : (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Guest</th>
            <th>Confirmation</th>
            <th>Stay dates</th>
            <th>Room</th>
            <th>Status</th>
            <th>Source / Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>
                <button
                  className="text-button guest-name"
                  onClick={() => onSelect(r.id)}
                >
                  {r.guest_name}
                </button>
                {r.vip && <Badge tone="amber">VIP</Badge>}
              </td>
              <td className="mono">{r.confirmation}</td>
              <td>
                {r.arrival.slice(0, 10)}
                <small>to {r.departure.slice(0, 10)}</small>
              </td>
              <td>{r.room || "Unassigned"}</td>
              <td>
                <Badge tone={r.status === "InHouse" ? "green" : ""}>
                  {r.status}
                </Badge>
              </td>
              <td>
                {r.source}
                <small>{time(r.updated_at)}</small>
              </td>
              <td>
                <button
                  aria-label={`View ${r.confirmation}`}
                  onClick={() => onSelect(r.id)}
                >
                  <ArrowUpRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export default function Operations() {
  const { section } = useParams();
  const { user, propertyId, date } = useWorkspace();
  const [params] = useSearchParams();
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [arrival, setArrival] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState("");
  const isRooms = section === "rooms",
    isTasks = section === "tasks",
    isReservations = !isRooms && !isTasks;
  const view =
    section === "arrivals"
      ? "arrivals"
      : section === "departures"
        ? "departures"
        : section === "inhouse"
          ? "inhouse"
          : params.get("view") || "";
  useEffect(() => {
    setPage(1);
    setSelected("");
  }, [section, propertyId, search, status, arrival, view]);
  const reservations = useData<{ items: Reservation[]; total: number }>(
    [
      "reservations",
      propertyId,
      date,
      section,
      search,
      status,
      arrival,
      page,
      view,
    ],
    `/reservations?${new URLSearchParams({ propertyId, date, page: String(page), q: search, ...(status ? { status } : {}), ...(arrival ? { arrival } : {}), ...(view ? { view } : {}) })}`,
    !!propertyId && isReservations && canGuests(user.role),
  );
  const tasks = useData<{ items: Task[]; total: number }>(
    ["tasks", propertyId, page],
    `/tasks?propertyId=${propertyId}&page=${page}`,
    !!propertyId && isTasks,
  );
  const rooms = useData<{ items: any[]; total: number }>(
    ["rooms", propertyId, page],
    `/rooms?propertyId=${propertyId}&page=${page}`,
    !!propertyId && isRooms,
  );
  const assignees = useData<{ items: { id: string; name: string }[] }>(
    ["assignees", propertyId],
    `/assignees?propertyId=${propertyId}`,
    !!propertyId && isTasks,
  );
  const detail = useData<any>(
    ["reservations", propertyId, selected],
    `/reservations/${encodeURIComponent(selected)}?propertyId=${propertyId}`,
    !!selected,
  );
  const title =
    (
      {
        rooms: "Rooms & Housekeeping (View)",
        inhouse: "In-House Guests",
        tasks: "Priority Tasks",
        arrivals: "Today's Arrivals",
        departures: "Today's Departures",
        guests: "Guest Profiles",
        reservations: "Reservations",
      } as any
    )[section || ""] || "Reservations";
  if (!propertyId) return <Empty text="No property assigned." />;
  if (isReservations && !canGuests(user.role))
    return <Empty text="Your role does not include guest record access." />;
  return (
    <>
      <Heading
        eyebrow="HOTEL OPERATIONS"
        title={title}
        description={
          section === "guests"
            ? "Guest summaries from the reservation read model. A dedicated Oracle profile feed is not connected."
            : "The details that keep your property running smoothly."
        }
      />
      {isReservations && (
        <section className="panel">
          <div className="toolbar">
            <label className="search-input">
              <Search size={17} />
              <input
                aria-label="Search reservations"
                placeholder="Guest name or confirmation number"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <select
              aria-label="Reservation status"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">All statuses</option>
              {[
                "Reserved",
                "InHouse",
                "CheckedOut",
                "Cancelled",
                "DueIn",
                "DueOut",
              ].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <label className="inline-label">
              Arrival
              <input
                type="date"
                aria-label="Arrival date"
                value={arrival}
                onChange={(e) => setArrival(e.target.value)}
              />
            </label>
            {view && <Badge>{view}</Badge>}
          </div>
          <State query={reservations}>
            <ReservationTable
              items={reservations.data?.items || []}
              onSelect={setSelected}
            />
            <Pager
              page={page}
              setPage={setPage}
              total={reservations.data?.total || 0}
            />
          </State>
        </section>
      )}
      {isTasks && (
        <>
          <p className="helper">
            Read-only local task history. Operational edits are disabled.
          </p>
          <section className="panel">
            <State query={tasks}>
              {!tasks.data?.items.length ? (
                <Empty text="No task history for this property." />
              ) : (
                <div className="task-list">
                  {tasks.data?.items.map((t) => (
                    <article key={t.id}>
                      <div>
                        <Badge tone={t.priority === "high" ? "rose" : ""}>
                          {t.priority}
                        </Badge>
                        <h3>{t.title}</h3>
                        <small>Updated {time(t.updated_at)}</small>
                      </div>
                      <dl>
                        <div>
                          <dt>Assigned to</dt>
                          <dd>
                            {assignees.data?.items.find(
                              (a) => a.id === t.assignee,
                            )?.name ||
                              t.assignee ||
                              "Unassigned"}
                          </dd>
                        </div>
                        <div>
                          <dt>Status</dt>
                          <dd>{t.status}</dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>
              )}
              <Pager
                page={page}
                setPage={setPage}
                total={tasks.data?.total || 0}
              />
            </State>
          </section>
        </>
      )}
      {isRooms && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Room readiness</h2>
              <p>Local housekeeping state · Updates are audited</p>
            </div>
          </div>
          <State query={rooms}>
            {!rooms.data?.items.length ? (
              <Empty text="No room data has been imported." />
            ) : (
              <div className="room-grid">
                {rooms.data?.items.map((r) => (
                  <div className="room-card" key={r.id}>
                    <div>
                      <h2>{r.id}</h2>
                      <Badge tone={r.attention ? "amber" : "green"}>
                        {r.status}
                      </Badge>
                    </div>
                    <p>{r.attention || "Ready for the next guest"}</p>
                    <small>{time(r.updated_at)}</small>
                  </div>
                ))}
              </div>
            )}
            <Pager
              page={page}
              setPage={setPage}
              total={rooms.data?.total || 0}
            />
          </State>
        </section>
      )}
      {selected && (
        <div className="modal-backdrop">
          <section
            className="detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Reservation detail"
          >
            <button
              className="close"
              aria-label="Close detail"
              onClick={() => setSelected("")}
            >
              <X />
            </button>
            <p className="eyebrow">RESERVATION DETAIL</p>
            <State query={detail}>
              <h2>{detail.data?.guest_name}</h2>
              <Badge tone="green">{detail.data?.status}</Badge>
              {detail.data?.vip && <Badge tone="amber">VIP</Badge>}
              <dl>
                {[
                  ["Confirmation", detail.data?.confirmation],
                  ["Arrival", detail.data?.arrival?.slice(0, 10)],
                  ["Departure", detail.data?.departure?.slice(0, 10)],
                  ["Room", detail.data?.room || "Unassigned"],
                  ["Source", detail.data?.source],
                  ["Updated", time(detail.data?.updated_at)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="helper">
                Read-only reservation snapshot. No Oracle actions are available.
              </p>
            </State>
          </section>
        </div>
      )}
    </>
  );
}
