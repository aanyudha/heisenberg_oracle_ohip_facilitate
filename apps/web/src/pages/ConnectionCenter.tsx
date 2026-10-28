import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useData, write, time } from "../api";
import { Badge, Empty, Pager, State } from "../components";
type Assignment = {
  property_id: string;
  name: string;
  hotel_id: string;
  is_primary: boolean;
  validation_status: string;
  last_validated_at: string | null;
  last_sync: string | null;
  status: string;
};
type Connection = {
  id: string;
  base_url: string;
  client_id: string;
  enterprise_id: string;
  status: string;
  health: string;
  last_connected: string | null;
  can_edit: boolean;
  assigned_properties: Assignment[];
};
type Action = "choose" | "create" | "edit" | "existing";
const friendly: Record<string, string> = {
  permission:
    "OHIP denied access to this Hotel ID. Check the Hotel ID and property permissions.",
  authentication:
    "OCIM authentication failed. Check Client ID, client secret, application key and Enterprise ID.",
  contract: "OHIP could not validate this Hotel ID using the reservation API.",
  network:
    "The OHIP gateway could not be reached. Check gateway access and try again.",
  gateway_not_allowed: "This HTTPS gateway is not on the server allowlist.",
  throttled: "OHIP is throttling requests. Wait before testing again.",
};
export default function ConnectionCenter({
  propertyId,
}: {
  propertyId: string;
}) {
  const client = useQueryClient();
  const [page, setPage] = useState(1),
    [action, setAction] = useState<Action>("choose"),
    [selected, setSelected] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const data = useData<{ items: Connection[]; total: number }>(
    ["ohip-connections", propertyId, page],
    `/ohip-connections?propertyId=${encodeURIComponent(propertyId)}&page=${page}&limit=25`,
  );
  const items = data.data?.items || [];
  const assigned = items.find((c) =>
    c.assigned_properties.some((m) => m.property_id === propertyId),
  );
  const editing = items.find((c) => c.id === selected);
  const mapping = editing?.assigned_properties.find(
    (m) => m.property_id === propertyId,
  );
  async function request(path: string, body: unknown, method = "POST") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await write(path, body, method);
      await client.invalidateQueries({
        predicate: (q) =>
          q.queryKey[0] === "ohip-connections" ||
          q.queryKey.includes(propertyId),
      });
      setMessage(
        "OHIP access verified. Connection and property assignment saved.",
      );
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setError(friendly[msg] || msg);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function choose(next: Action, c?: Connection) {
    setAction(next);
    setSelected(c?.id || assigned?.id || items[0]?.id || "");
    setError("");
    setMessage("");
  }
  return (
    <>
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
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Connection List</h2>
            <p>
              Credentials stay encrypted on the server. Each property has its
              own Hotel ID.
            </p>
          </div>
        </div>
        <div className="actions">
          <button disabled={busy} onClick={() => choose("create")}>
            Create New Connection
          </button>
          <button
            disabled={busy || !items.length}
            onClick={() => choose("existing")}
          >
            Use Existing Connection
          </button>
          {assigned && (
            <button disabled={busy} onClick={() => choose("create")}>
              Create Dedicated Connection
            </button>
          )}
        </div>
        <State query={data}>
          {!items.length ? (
            <Empty text="No accessible OHIP connections yet. Create a connection for the selected property." />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Connection</th>
                    <th>Connection Health</th>
                    <th>Last Connected</th>
                    <th>Assigned Properties</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => {
                    const current = c.assigned_properties.find(
                      (m) => m.property_id === propertyId,
                    );
                    return (
                      <tr key={c.id}>
                        <td>
                          {c.base_url}
                          <small>{c.client_id}</small>
                          <small>Enterprise: {c.enterprise_id}</small>
                        </td>
                        <td>
                          <Badge
                            tone={
                              (c.health || c.status) === "connected"
                                ? "green"
                                : "amber"
                            }
                          >
                            {c.health || c.status}
                          </Badge>
                        </td>
                        <td>{time(c.last_connected)}</td>
                        <td>
                          {c.assigned_properties.map((m) => (
                            <div key={m.property_id}>
                              <strong>{m.name}</strong>
                              <small>
                                Hotel ID: {m.hotel_id}
                                {m.is_primary ? " (primary)" : ""}
                              </small>
                              <small>
                                {m.validation_status} /{" "}
                                {m.status || "not connected"}
                              </small>
                              <small>
                                Last validated: {time(m.last_validated_at)}
                              </small>
                            </div>
                          ))}
                        </td>
                        <td>
                          {current ? (
                            <>
                              <button
                                disabled={busy || !c.can_edit}
                                onClick={() => choose("edit", c)}
                              >
                                Edit Connection
                              </button>
                              {!c.can_edit && (
                                <small>
                                  Shared credentials require access to all
                                  assigned properties to edit. You can create a
                                  dedicated connection.
                                </small>
                              )}
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void request(
                                    `/ohip-connections/${c.id}/test`,
                                    { propertyId },
                                  )
                                }
                              >
                                Test Connection
                              </button>
                            </>
                          ) : (
                            <button
                              disabled={busy}
                              onClick={() => choose("existing", c)}
                            >
                              Use This Connection
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={page} setPage={setPage} total={data.data?.total || 0} />
        </State>
      </section>
      {action === "choose" && (
        <p className="helper">
          Select a connection for the current property, or create a new
          connection. Hotel access is validated before activation. DEMO
          properties keep their existing sample adapter.
        </p>
      )}
      {action === "existing" && (
        <section className="panel">
          <h2>Use Existing Connection</h2>
          <form
            className="form-grid"
            aria-label="Assign Existing Connection"
            key={`existing-${propertyId}-${selected}`}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                f = new FormData(form);
              void request(
                `/ohip-connections/${f.get("connectionId")}/assign`,
                { propertyId, hotelId: f.get("hotelId") },
              ).then((ok) => {
                if (ok) {
                  form.reset();
                  setAction("choose");
                }
              });
            }}
          >
            <label className="full">
              Connection
              <select
                name="connectionId"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                required
              >
                {items.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.base_url} / {c.client_id}
                  </option>
                ))}
              </select>
            </label>
            <label className="full">
              Hotel ID
              <input
                name="hotelId"
                maxLength={40}
                defaultValue={mapping?.hotel_id || ""}
                required
                autoComplete="off"
              />
            </label>
            <p className="helper full">
              Only this property's Hotel ID is required. Credentials are reused
              within your tenant; they are never copied to the browser.
            </p>
            <button className="primary full" disabled={busy || !selected}>
              {busy ? "Validating access..." : "Validate and Assign"}
            </button>
          </form>
        </section>
      )}
      {(action === "create" || action === "edit") && (
        <section className="panel">
          <h2>{action === "edit" ? "Edit Connection" : "Create Connection"}</h2>
          <form
            className="form-grid"
            aria-label={
              action === "edit" ? "Edit Connection" : "Create Connection"
            }
            key={`${action}-${selected}-${propertyId}`}
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                f = new FormData(form),
                editing = action === "edit";
              const values = Object.fromEntries(
                [
                  "baseUrl",
                  "clientId",
                  "clientSecret",
                  "appKey",
                  "enterpriseId",
                  "hotelId",
                ].map((key) => [key, String(f.get(key) || "")]),
              );
              void request(
                editing ? `/ohip-connections/${selected}` : "/ohip-connections",
                { propertyId, ...values },
                editing ? "PATCH" : "POST",
              ).then((ok) => {
                if (ok) {
                  form.reset();
                  setAction("choose");
                }
              });
            }}
          >
            <label className="full">
              Gateway URL
              <input
                name="baseUrl"
                type="url"
                maxLength={300}
                required
                defaultValue={action === "edit" ? editing?.base_url : ""}
                placeholder="https://gateway.example.oraclecloud.com"
              />
            </label>
            <label>
              Client ID
              <input
                name="clientId"
                maxLength={200}
                required
                autoComplete="off"
                defaultValue={action === "edit" ? editing?.client_id : ""}
              />
            </label>
            <label>
              Client secret
              <input
                name="clientSecret"
                type="password"
                maxLength={1000}
                required={action === "create"}
                autoComplete="new-password"
              />
            </label>
            <label>
              Application key
              <input
                name="appKey"
                type="password"
                maxLength={1000}
                required={action === "create"}
                autoComplete="new-password"
              />
            </label>
            <label>
              Enterprise ID
              <input
                name="enterpriseId"
                maxLength={100}
                required
                autoComplete="off"
                defaultValue={action === "edit" ? editing?.enterprise_id : ""}
              />
            </label>
            <label>
              Hotel ID
              <input
                name="hotelId"
                maxLength={40}
                required
                autoComplete="off"
                defaultValue={action === "edit" ? mapping?.hotel_id : ""}
              />
            </label>
            <p className="helper full">
              OAuth scope is managed by the backend. Gateway must be on the
              HTTPS allowlist. Access to the Hotel ID is tested before
              activation.
              {action === "edit"
                ? " Leave client secret and application key empty to preserve their saved values. Changes to shared credentials are tested against every assigned Hotel ID."
                : " Identical credentials are reused rather than stored twice. Use an empty property for Oracle data."}
            </p>
            <button className="primary full" disabled={busy}>
              {busy
                ? "Validating access..."
                : action === "edit"
                  ? "Validate and Save Changes"
                  : "Validate and Create"}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
