import { useEffect, useState } from "react";
import ConnectionCenter from "./ConnectionCenter";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, RotateCcw } from "lucide-react";
import { useWorkspace } from "../workspace";
import { useData, write, time } from "../api";
import { Badge, Empty, Heading, Pager, State } from "../components";
export default function Integrations() {
  const { section } = useParams();
  const { propertyId } = useWorkspace();
  const client = useQueryClient();
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
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
          <ConnectionCenter key={propertyId} propertyId={propertyId} />
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
