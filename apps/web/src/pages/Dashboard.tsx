import { Link } from "react-router-dom";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Users,
  Star,
  ArrowUpRight,
  CheckCheck,
  DoorOpen,
  Clock3,
} from "lucide-react";
import type { Summary, Task } from "@hospitality/contracts";
import { canGuests } from "@hospitality/contracts";
import { useWorkspace } from "../workspace";
import { useData, time } from "../api";
import { Badge, Empty, Heading, State } from "../components";
export default function Dashboard() {
  const { user, propertyId, date } = useWorkspace();
  const summary = useData<{ items: Summary[] }>(
    ["overview", propertyId, date],
    `/overview?propertyId=${propertyId}&date=${date}`,
    !!propertyId,
  );
  const tasks = useData<{ items: Task[] }>(
    ["tasks", propertyId],
    `/tasks?propertyId=${propertyId}`,
    !!propertyId,
  );
  const s = summary.data?.items[0];
  return (
    <>
      <Heading
        eyebrow="YOUR DAILY PULSE"
        title="Every detail. A smoother day."
        description={`Your morning briefing for ${new Date(date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.`}
        action={
          <Link className="button" to="/group/overview">
            View all properties <ArrowUpRight size={16} />
          </Link>
        }
      />
      {!propertyId ? (
        <Empty text="No properties assigned. Ask your organization administrator for access." />
      ) : (
        <State query={summary}>
          <div className="source-banner">
            <span>
              <i />
              {s?.source === "demo" ? "DEMO WORKSPACE" : "LOCAL READ MODEL"}
            </span>
            <p>
              {s?.source === "demo"
                ? "Sample hotel data. Oracle ingestion is not active."
                : `OHIP status: ${s?.connection || "not configured"}. Polling source; streaming is not active.`}
            </p>
            <small>
              {s?.source === "demo"
                ? "Sample adapter checked"
                : "Last successful Oracle sync"}{" "}
              {time(s?.lastSync)}. Snapshot status:{" "}
              {s?.freshness || "not verified"}.
            </small>
          </div>
          <div className="metric-grid">
            {[
              {
                label: "Today's arrivals",
                value: s?.arrivals,
                Icon: ArrowDownToLine,
                to: "arrivals",
                sub: "Prepare a warm welcome",
                color: "mint",
              },
              {
                label: "Today's departures",
                value: s?.departures,
                Icon: ArrowUpFromLine,
                to: "departures",
                sub: "Make the last impression count",
                color: "blue",
              },
              {
                label: "In-house guests",
                value: s?.inHouse,
                Icon: Users,
                to: "reservations?view=inhouse",
                sub: "Currently checked in",
                color: "violet",
              },
              {
                label: "VIP arrivals",
                value: s?.vip,
                Icon: Star,
                to: "reservations?view=vip",
                sub: "A little extra attention",
                color: "gold",
              },
            ].map((m) => (
              <Link
                aria-disabled={!canGuests(user.role)}
                onClick={(e) => {
                  if (!canGuests(user.role)) e.preventDefault();
                }}
                className="metric"
                key={m.label}
                to={"/operations/" + m.to}
              >
                <div className="metric-top">
                  <span>{m.label}</span>
                  <span className={"metric-icon " + m.color}>
                    <m.Icon size={19} />
                  </span>
                </div>
                <strong>{m.value ?? 0}</strong>
                <div className="metric-bottom">
                  <span>{m.sub}</span>
                  <ArrowUpRight size={16} />
                </div>
              </Link>
            ))}
          </div>
          <div className="dashboard-columns">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Where your attention matters</h2>
                  <p>Clear priorities for your team today</p>
                </div>
                <Badge tone="amber">{s?.pending || 0} pending</Badge>
              </div>
              <State query={tasks}>
                {tasks.data?.items.filter((t) => t.status !== "done").length ? (
                  <div className="task-preview">
                    {tasks.data?.items
                      .filter((t) => t.status !== "done")
                      .slice(0, 4)
                      .map((t) => (
                        <Link to="/operations/tasks" key={t.id}>
                          <span
                            className={
                              "task-check " +
                              (t.priority === "high" ? "urgent" : "")
                            }
                          >
                            <CheckCheck size={18} />
                          </span>
                          <div>
                            <b>{t.title}</b>
                            <small>
                              {t.status === "acknowledged"
                                ? "Acknowledged"
                                : "Awaiting acknowledgment"}{" "}
                              · {t.assignee || "Unassigned"}
                            </small>
                          </div>
                          <Badge tone={t.priority === "high" ? "rose" : ""}>
                            {t.priority}
                          </Badge>
                        </Link>
                      ))}
                  </div>
                ) : (
                  <Empty text="No pending tasks. Your team is up to date." />
                )}
              </State>
              <Link className="panel-link" to="/operations/tasks">
                View priority tasks <ArrowUpRight size={16} />
              </Link>
            </section>
            <section className="panel readiness">
              <div className="panel-heading">
                <div>
                  <h2>Property readiness</h2>
                  <p>Keep the guest journey moving</p>
                </div>
                <DoorOpen size={20} />
              </div>
              <Link to="/operations/rooms">
                <span className="readiness-icon">
                  <DoorOpen size={20} />
                </span>
                <div>
                  <strong>{s?.attention || 0}</strong>
                  <p>Rooms requiring attention</p>
                </div>
                <ArrowUpRight size={18} />
              </Link>
              <Link to="/operations/reservations?view=changes">
                <span className="readiness-icon blue">
                  <Clock3 size={20} />
                </span>
                <div>
                  <strong>{s?.changes || 0}</strong>
                  <p>Reservation records updated today</p>
                </div>
                <ArrowUpRight size={18} />
              </Link>
              <div className="readiness-note">
                <i /> Changes are reflected automatically
              </div>
            </section>
          </div>
          <section className="briefing-bottom">
            <div>
              <span className="eyebrow">A CONNECTED OPERATION</span>
              <h2>Your properties. One shared perspective.</h2>
              <p>
                Spot exceptions, compare activity, and help every team stay a
                step ahead.
              </p>
            </div>
            <Link className="button primary" to="/group/overview">
              Open command center <ArrowUpRight size={16} />
            </Link>
          </section>
        </State>
      )}
    </>
  );
}
