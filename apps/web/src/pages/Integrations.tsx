import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Plug, ShieldCheck, RotateCcw } from "lucide-react";
import { useWorkspace } from "../workspace";
import { useData, write, time } from "../api";
import { Badge, Empty, Heading, Pager, State } from "../components";
export default function Integrations() {
  const { section } = useParams();
  const { propertyId } = useWorkspace();
  const client = useQueryClient();
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [mode, setMode] = useState("demo"),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setPage(1);
    setError("");
    setMessage("");
  }, [section, propertyId]);
  const resource =
    section === "logs"
      ? "integration-logs"
      : section === "retries"
        ? "retry-jobs"
        : "connections";
  const data = useData<{ items: any[]; total: number }>(
    [resource, propertyId, page],
    `/${resource}?propertyId=${propertyId}&page=${page}`,
    !!propertyId,
  );
  const connection = data.data?.items[0];
  async function save(path: string, body: unknown, method = "POST") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await write(path, body, method);
      setMessage("Saved. Changes will appear automatically.");
      await client.invalidateQueries({
        predicate: (q) => q.queryKey.includes(propertyId),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = (
    {
      connections: "OHIP Connections",
      health: "Integration Health",
      logs: "Request & Error Logs",
      retries: "Retry Queue",
    } as any
  )[section || ""];
  if (!propertyId) return <Empty text="No property assigned." />;
  return (
    <>
      <Heading
        eyebrow="INTEGRATIONS"
        title={title}
        description="Understand the source. Spot exceptions. Recover with confidence."
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="success">
          {message}
        </p>
      )}
      <div className="integration-note">
        <ShieldCheck size={20} />
        <span>
          Read-only Operations API · Controlled polling · Business Events /
          Streaming not enabled
        </span>
      </div>
      <State query={data}>
        {section === "connections" ? (
          <div className="integration-columns">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Connection configuration</h2>
                  <p>
                    Credentials are encrypted and never returned to the browser.
                  </p>
                </div>
                <Plug size={21} />
              </div>
              <form
                className="form-grid"
                key={propertyId}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void save(
                    "/connections",
                    {
                      propertyId,
                      mode,
                      environment: f.get("environment"),
                      gateway: f.get("gateway") || "",
                      hotelId: f.get("hotelId") || "",
                      chainCode: f.get("chainCode") || "",
                      enterpriseId: f.get("enterpriseId") || "",
                      ...(mode === "real"
                        ? {
                            clientId: f.get("clientId"),
                            clientSecret: f.get("clientSecret"),
                            applicationKey: f.get("applicationKey"),
                          }
                        : {}),
                    },
                    "PUT",
                  );
                }}
              >
                <label>
                  Data source
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="demo">DEMO · Mock adapter</option>
                    <option value="real">Oracle OHIP · OCIM</option>
                  </select>
                </label>
                <label>
                  Environment
                  <select name="environment" key={mode}>
                    {(mode === "demo"
                      ? ["DEMO"]
                      : ["sandbox", "production"]
                    ).map((e) => (
                      <option key={e}>{e}</option>
                    ))}
                  </select>
                </label>
                {mode === "real" && (
                  <>
                    <label className="full">
                      HTTPS Gateway
                      <input
                        name="gateway"
                        defaultValue={connection?.gateway}
                        placeholder="https://gateway.example.oraclecloud.com"
                        type="url"
                        required
                      />
                    </label>
                    <label>
                      Hotel ID
                      <input
                        name="hotelId"
                        defaultValue={connection?.hotel_id}
                        required
                      />
                    </label>
                    <label>
                      Chain mapping
                      <input
                        name="chainCode"
                        defaultValue={connection?.chain_code}
                      />
                    </label>
                    <label className="full">
                      Enterprise ID
                      <input
                        name="enterpriseId"
                        defaultValue={connection?.enterprise_id}
                        required
                      />
                    </label>
                    <label>
                      Client ID
                      <input name="clientId" required autoComplete="off" />
                    </label>
                    <label>
                      Client secret
                      <input
                        name="clientSecret"
                        type="password"
                        required
                        autoComplete="new-password"
                      />
                    </label>
                    <label className="full">
                      Application key
                      <input
                        name="applicationKey"
                        type="password"
                        required
                        autoComplete="new-password"
                      />
                    </label>
                    <p className="helper full">
                      Gateway must be on the server's configured allowlist.
                      Saving replaces the credentials. Test against an
                      authorized sandbox before using a production environment.
                    </p>
                  </>
                )}
                <button className="primary full" disabled={busy}>
                  Save connection
                </button>
              </form>
            </section>
            <section className="panel connection-card">
              <span className="large-icon">
                <Activity size={30} />
              </span>
              <h2>Current source status</h2>
              <Badge
                tone={
                  connection?.mode === "demo"
                    ? "amber"
                    : connection?.status === "connected"
                      ? "green"
                      : "rose"
                }
              >
                {connection?.status || "Not configured"}
              </Badge>
              <dl>
                <div>
                  <dt>Mode</dt>
                  <dd>{connection?.mode || "—"}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>{connection?.environment || "—"}</dd>
                </div>
                <div>
                  <dt>Last source sync</dt>
                  <dd>{time(connection?.last_sync)}</dd>
                </div>
              </dl>
              <p className="helper">
                DEMO sync confirms the local sample adapter. It does not contact
                Oracle or refresh sample reservations.
              </p>
            </section>
          </div>
        ) : section === "health" ? (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Source health & reconciliation</h2>
                <p>State reported by the backend polling worker</p>
              </div>
            </div>
            {connection ? (
              <>
                <div className="health-grid">
                  <div>
                    <span>Status</span>
                    <strong>{connection.status}</strong>
                  </div>
                  <div>
                    <span>Environment</span>
                    <strong>{connection.environment}</strong>
                  </div>
                  <div>
                    <span>Last source sync</span>
                    <strong>{time(connection.last_sync)}</strong>
                  </div>
                </div>
                <pre>{JSON.stringify(connection.checkpoint, null, 2)}</pre>
                <p className="helper">
                  Each completed poll stores its checkpoint. Failed polls enter
                  bounded recovery. Guest data is never included in the realtime
                  event stream.
                </p>
              </>
            ) : (
              <Empty text="No connection configured for this property." />
            )}
          </section>
        ) : (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  {section === "logs" ? "Request telemetry" : "Recovery jobs"}
                </h2>
                <p>
                  {section === "logs"
                    ? "Sanitized metadata only. No tokens or guest payloads."
                    : "Automatic retries use bounded exponential backoff. Exhausted jobs enter the dead-letter queue."}
                </p>
              </div>
            </div>
            {!data.data?.items.length ? (
              <Empty text="No integration records yet." />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      {(section === "logs"
                        ? [
                            "Time",
                            "Operation",
                            "HTTP",
                            "Latency",
                            "Classification",
                            "Correlation ID",
                          ]
                        : [
                            "Job / operation",
                            "State",
                            "Attempts",
                            "Next attempt",
                            "Last error",
                            "Action",
                          ]
                      ).map((t) => (
                        <th key={t}>{t}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.data?.items.map((r) => (
                      <tr key={r.id}>
                        {section === "logs" ? (
                          <>
                            <td>{time(r.created_at)}</td>
                            <td>{r.operation}</td>
                            <td>
                              <Badge tone={r.status >= 400 ? "rose" : "green"}>
                                {r.status || "Network"}
                              </Badge>
                            </td>
                            <td>{r.latency} ms</td>
                            <td>{r.classification}</td>
                            <td className="mono">{r.correlation_id}</td>
                          </>
                        ) : (
                          <>
                            <td>
                              {r.operation}
                              <small className="mono">{r.id}</small>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  r.state === "dead"
                                    ? "rose"
                                    : r.state === "done"
                                      ? "green"
                                      : "amber"
                                }
                              >
                                {r.state === "dead" ? "Dead letter" : r.state}
                              </Badge>
                            </td>
                            <td>
                              {r.attempts}/{r.max_attempts}
                            </td>
                            <td>{time(r.next_at)}</td>
                            <td>{r.last_error || "—"}</td>
                            <td>
                              <button
                                disabled={
                                  busy || !["dead", "queued"].includes(r.state)
                                }
                                onClick={() =>
                                  void save("/retry-jobs/" + r.id + "/retry", {
                                    propertyId,
                                  })
                                }
                              >
                                <RotateCcw size={14} /> Retry read
                              </button>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager
              page={page}
              setPage={setPage}
              total={data.data?.total || 0}
            />
          </section>
        )}
      </State>
    </>
  );
}
