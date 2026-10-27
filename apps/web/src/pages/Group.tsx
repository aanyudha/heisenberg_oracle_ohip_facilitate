import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Summary } from "@hospitality/contracts";
import { useWorkspace } from "../workspace";
import { useData, time } from "../api";
import { Badge, Empty, Heading, State } from "../components";
export default function Group() {
  const { section } = useParams();
  const { user, date, selectProperty } = useWorkspace();
  const [organization, setOrganization] = useState("");
  const data = useData<{ items: Summary[] }>(
    ["overview", "group", date, organization],
    `/overview?date=${date}${organization ? "&organizationId=" + organization : ""}`,
  );
  const rows = data.data?.items || [];
  const organizations = [
    ...new Set(user.properties.map((p) => p.organization_id)),
  ];
  const alerts = rows.flatMap((r) => [
    ...(r.connection !== "connected" && r.source !== "demo"
      ? [{ r, text: "OHIP connection requires attention", severity: "rose" }]
      : []),
    ...(r.pending
      ? [
          {
            r,
            text: `${r.pending} tasks awaiting completion`,
            severity: "amber",
          },
        ]
      : []),
    ...(r.attention
      ? [
          {
            r,
            text: `${r.attention} rooms require attention`,
            severity: "amber",
          },
        ]
      : []),
  ]);
  return (
    <>
      <Heading
        eyebrow="GROUP OPERATIONS"
        title={
          section === "comparison"
            ? "Property Comparison"
            : section === "alerts"
              ? "Property Alerts"
              : "Multi-Property Command Center"
        }
        description="A shared view across your authorized properties. Aggregated securely on the server."
        action={
          <select
            aria-label="Organization"
            value={organization}
            onChange={(e) => setOrganization(e.target.value)}
          >
            <option value="">All authorized organizations</option>
            {organizations.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        }
      />
      <State query={data}>
        {!rows.length ? (
          <Empty text="No properties available for this selection." />
        ) : section === "alerts" ? (
          <section className="panel">
            {alerts.length ? (
              alerts.map((a, i) => (
                <div className="alert-row" key={i}>
                  <Badge tone={a.severity}>Attention</Badge>
                  <div>
                    <b>{a.r.property.name}</b>
                    <p>{a.text}</p>
                  </div>
                  <Link
                    className="button"
                    to="/"
                    onClick={() => selectProperty?.(a.r.property.id)}
                  >
                    Open operations →
                  </Link>
                </div>
              ))
            ) : (
              <Empty text="No active property alerts." />
            )}
          </section>
        ) : (
          <>
            <div className="metric-grid group-totals">
              {[
                ["Authorized properties", rows.length],
                ["Arrivals", rows.reduce((n, r) => n + r.arrivals, 0)],
                ["Departures", rows.reduce((n, r) => n + r.departures, 0)],
                ["Pending tasks", rows.reduce((n, r) => n + r.pending, 0)],
              ].map(([label, value]) => (
                <div className="metric" key={label}>
                  <p>{label}</p>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Across the collection</h2>
                  <p>
                    Selected date: {date} · Current read model, without
                    historical snapshots
                  </p>
                </div>
                <Badge>{rows.length} properties</Badge>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Property</th>
                      <th>Arrivals</th>
                      <th>Departures</th>
                      <th>In house</th>
                      <th>VIP</th>
                      <th>Tasks</th>
                      <th>Connection</th>
                      <th>Last source sync</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.property.id}>
                        <td>
                          <Link
                            to="/"
                            onClick={() => selectProperty?.(r.property.id)}
                          >
                            <b>{r.property.name}</b>
                          </Link>
                          <small>
                            {r.source === "demo"
                              ? "DEMO DATA"
                              : "OHIP polling read model"}
                          </small>
                        </td>
                        <td>
                          <span className="comparison-value">{r.arrivals}</span>
                          {section === "comparison" && (
                            <div className="bar">
                              <i
                                style={{
                                  width: `${(r.arrivals / Math.max(1, ...rows.map((r) => r.arrivals))) * 100}%`,
                                }}
                              />
                            </div>
                          )}
                        </td>
                        <td>{r.departures}</td>
                        <td>{r.inHouse}</td>
                        <td>{r.vip}</td>
                        <td>
                          <Badge tone={r.pending ? "amber" : "green"}>
                            {r.pending}
                          </Badge>
                        </td>
                        <td>
                          <Badge
                            tone={
                              r.connection === "connected"
                                ? "green"
                                : r.source === "demo"
                                  ? ""
                                  : "rose"
                            }
                          >
                            {r.connection || "Not configured"}
                          </Badge>
                        </td>
                        <td>{time(r.lastSync)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <p className="helper">
              Select a property in the header to drill into its{" "}
              <Link to="/">morning briefing</Link>. Date filters apply to
              reservation dates; tasks and connection health show current state.
            </p>
          </>
        )}
      </State>
    </>
  );
}
