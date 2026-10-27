import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Search, Plus, X, ArrowUpRight } from "lucide-react";
import type { Reservation, Task } from "@hospitality/contracts";
import { canGuests } from "@hospitality/contracts";
import { useWorkspace } from "../workspace";
import { useData, write, time } from "../api";
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
  const client = useQueryClient();
  const [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [arrival, setArrival] = useState(""),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const isRooms = section === "rooms",
    isTasks = section === "tasks",
    isReservations = !isRooms && !isTasks;
  const view =
    section === "arrivals"
      ? "arrivals"
      : section === "departures"
        ? "departures"
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
  async function mutate(path: string, body: unknown, method = "POST") {
    setError("");
    setBusy(true);
    try {
      await write(path, body, method);
      await client.invalidateQueries({
        predicate: (q) => q.queryKey.includes(propertyId),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title =
    (
      {
        rooms: "Rooms & Housekeeping",
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
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
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
          <form
            className="panel inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              await mutate("/tasks", {
                propertyId,
                title: f.get("title"),
                priority: f.get("priority"),
              });
              form.reset();
            }}
          >
            <input
              name="title"
              placeholder="What needs attention?"
              aria-label="Task title"
              required
              maxLength={180}
            />
            <select name="priority" aria-label="Task priority">
              <option value="normal">Normal priority</option>
              <option value="high">High priority</option>
              <option value="low">Low priority</option>
            </select>
            <button className="primary" disabled={busy || user.role === "it"}>
              <Plus size={16} /> Add task
            </button>
          </form>
          <section className="panel">
            <State query={tasks}>
              {!tasks.data?.items.length ? (
                <Empty text="No tasks yet. Create the first task for this property." />
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
                      <label>
                        Assign to
                        <select
                          disabled={busy || user.role === "it"}
                          value={t.assignee || ""}
                          onChange={(e) =>
                            void mutate(
                              "/tasks/" + t.id,
                              {
                                propertyId,
                                status: t.status,
                                assignee: e.target.value || null,
                              },
                              "PATCH",
                            )
                          }
                        >
                          <option value="">Unassigned</option>
                          {assignees.data?.items.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Status
                        <select
                          disabled={busy || user.role === "it"}
                          value={t.status}
                          onChange={(e) =>
                            void mutate(
                              "/tasks/" + t.id,
                              {
                                propertyId,
                                status: e.target.value,
                                assignee: t.assignee,
                              },
                              "PATCH",
                            )
                          }
                        >
                          <option value="open">Open</option>
                          <option value="acknowledged">Acknowledged</option>
                          <option value="done">Done</option>
                        </select>
                      </label>
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
                    {[
                      "platform_admin",
                      "group_admin",
                      "hotel_manager",
                      "housekeeping",
                    ].includes(user.role) && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void mutate(
                            "/rooms/" + r.id,
                            {
                              propertyId,
                              status:
                                r.status === "inspected"
                                  ? "dirty"
                                  : "inspected",
                              attention:
                                r.status === "inspected"
                                  ? "Inspection required"
                                  : "",
                            },
                            "PATCH",
                          )
                        }
                      >
                        {r.status === "inspected"
                          ? "Mark dirty"
                          : "Mark inspected"}
                      </button>
                    )}
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
              <Link
                className="button primary"
                to="/operations/tasks"
                onClick={() => setSelected("")}
              >
                Create a related task <Plus size={16} />
              </Link>
            </State>
          </section>
        </div>
      )}
    </>
  );
}
