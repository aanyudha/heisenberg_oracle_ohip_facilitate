import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { roles } from "@hospitality/contracts";
import { useWorkspace } from "../workspace";
import { useData, write, time } from "../api";
import {
  Badge,
  Empty,
  Heading,
  Pager,
  State,
  ConfirmDialog,
} from "../components";
export default function Admin() {
  const { section } = useParams();
  const { user } = useWorkspace();
  const client = useQueryClient();
  const [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [page, setPage] = useState(1),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [archiving, setArchiving] = useState<any>(null);
  useEffect(() => {
    setMessage("");
    setError("");
    setEditing(null);
    setArchiving(null);
  }, [section]);
  const data = useData<any>(
    ["admin", user.tenantId],
    "/admin",
    section !== "audit",
  );
  const audits = useData<any>(
    ["audit-logs", user.tenantId, page],
    `/audit-logs?page=${page}`,
    section === "audit",
  );
  async function submit(path: string, body: unknown, method = "POST") {
    setBusy(true);
    setError("");
    try {
      await write(path, body, method);
      setMessage("Saved successfully.");
      setEditing(null);
      setArchiving(null);
      await client.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const onSubmit =
    (path: string, make: (f: FormData) => unknown, method = "POST") =>
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void submit(path, make(new FormData(e.currentTarget)), method);
    };
  const title = (
    {
      tenants: "Tenants",
      organizations: "Organizations",
      properties: "Properties",
      users: "Users & Roles",
      branding: "Branding",
      audit: "Audit Trail",
    } as any
  )[section || ""];
  return (
    <>
      <Heading
        eyebrow="ADMINISTRATION"
        title={title}
        description="Manage your organization within a securely isolated workspace."
      />
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
      {archiving && (
        <ConfirmDialog
          title="Archive internal record"
          busy={busy}
          onCancel={() => setArchiving(null)}
          onConfirm={() =>
            void submit(
              section === "branding"
                ? "/branding"
                : `/admin/${section}/${archiving.id}`,
              {},
              "DELETE",
            )
          }
        >
          Archive {archiving.name}? History and audit records are retained.
          Dependent records may prevent this action.
        </ConfirmDialog>
      )}
      {section === "branding" ? (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Your workspace identity</h2>
              <p>Applied to the app name, logo, favicon, and primary color.</p>
            </div>
          </div>
          <form
            className="form-grid"
            onSubmit={onSubmit(
              "/branding",
              (f) => Object.fromEntries(f),
              "PUT",
            )}
          >
            <label>
              Application name
              <input
                name="appName"
                required
                maxLength={60}
                defaultValue={user.branding.appName}
              />
            </label>
            <label>
              Primary color
              <input
                name="primary"
                type="color"
                defaultValue={user.branding.primary}
              />
            </label>
            <label className="full">
              Logo URL
              <input
                name="logo"
                defaultValue={user.branding.logo}
                placeholder="/logo.svg or HTTPS URL"
              />
            </label>
            <label className="full">
              Favicon URL
              <input name="favicon" defaultValue={user.branding.favicon} />
            </label>
            <button disabled={busy} className="primary full">
              Save branding
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setArchiving({
                  id: user.tenantId,
                  name: "workspace branding (restore defaults)",
                })
              }
            >
              Reset branding
            </button>
          </form>
        </section>
      ) : section === "audit" ? (
        <State query={audits}>
          <section className="panel">
            {!audits.data?.items.length ? (
              <Empty text="No administrator actions recorded." />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Property</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audits.data.items.map((r: any) => (
                      <tr key={r.id}>
                        <td>{time(r.created_at)}</td>
                        <td>{r.actor}</td>
                        <td>
                          <Badge>{r.action}</Badge>
                        </td>
                        <td className="mono">{r.target}</td>
                        <td>{r.property_id || "Organization"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pager
              page={page}
              setPage={setPage}
              total={audits.data?.total || 0}
            />
          </section>
        </State>
      ) : (
        <State query={data}>
          {section === "tenants" && user.role === "platform_admin" && (
            <form
              className="panel inline-form"
              onSubmit={onSubmit("/admin/tenants", (f) =>
                Object.fromEntries(f),
              )}
            >
              <input
                name="name"
                aria-label="Tenant name"
                placeholder="Tenant name"
                required
              />
              <input
                name="hostname"
                aria-label="App hostname"
                placeholder="workspace.example.com"
                required
              />
              <button className="primary" disabled={busy}>
                Provision tenant
              </button>
            </form>
          )}
          {editing && section !== "users" && (
            <section className="panel">
              <h2>Edit {editing.name}</h2>
              <form
                className="form-grid"
                onSubmit={onSubmit(
                  `/admin/${section}/${editing.id}`,
                  (f) => Object.fromEntries(f),
                  "PATCH",
                )}
              >
                <label>
                  Name
                  <input
                    name="name"
                    defaultValue={editing.name}
                    required
                    maxLength={100}
                  />
                </label>
                {section === "properties" && (
                  <>
                    <label>
                      Organization
                      <select
                        name="organizationId"
                        defaultValue={editing.organization_id}
                      >
                        {data.data?.organizations.map((o: any) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Timezone
                      <input
                        name="timezone"
                        defaultValue={editing.timezone}
                        required
                      />
                    </label>
                  </>
                )}
                <button disabled={busy} className="primary">
                  Save changes
                </button>
                <button type="button" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            </section>
          )}
          {section === "users" && editing && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Edit access · {editing.name}</h2>
                <button onClick={() => setEditing(null)}>Close</button>
              </div>
              <form
                key={editing.id}
                className="form-grid"
                onSubmit={onSubmit(
                  "/admin/users/" + editing.id,
                  (f) => ({
                    role: f.get("role"),
                    properties: f.getAll("properties"),
                  }),
                  "PATCH",
                )}
              >
                <label>
                  Role
                  <select name="role" defaultValue={editing.role}>
                    {roles
                      .filter(
                        (r) =>
                          r !== "platform_admin" ||
                          user.role === "platform_admin",
                      )
                      .map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                  </select>
                </label>
                <fieldset className="full">
                  <legend>Authorized properties</legend>
                  {user.properties.map((p) => (
                    <label className="checkbox-label" key={p.id}>
                      <input
                        name="properties"
                        type="checkbox"
                        value={p.id}
                        defaultChecked={editing.properties.includes(p.id)}
                      />
                      {p.name}
                    </label>
                  ))}
                </fieldset>
                <p className="helper full">
                  Saving signs this user out of this workspace and applies the
                  new access grants.
                </p>
                <button className="primary full" disabled={busy}>
                  Save access
                </button>
              </form>
            </section>
          )}
          {section === "organizations" && (
            <form
              className="panel inline-form"
              onSubmit={onSubmit("/admin/organizations", (f) => ({
                name: f.get("name"),
              }))}
            >
              <input
                required
                name="name"
                placeholder="Organization name"
                aria-label="Organization name"
              />
              <button disabled={busy} className="primary">
                Add organization
              </button>
            </form>
          )}
          {section === "properties" && (
            <form
              className="panel inline-form"
              onSubmit={onSubmit("/admin/properties", (f) =>
                Object.fromEntries(f),
              )}
            >
              <input
                required
                name="name"
                placeholder="Property name"
                aria-label="Property name"
              />
              <select name="organizationId" aria-label="Organization" required>
                {data.data?.organizations.map((o: any) => (
                  <option value={o.id} key={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <input
                name="timezone"
                aria-label="Timezone"
                defaultValue="Asia/Jakarta"
                required
              />
              <button disabled={busy} className="primary">
                Add property
              </button>
            </form>
          )}
          {section === "users" && (
            <section className="panel">
              <div className="panel-heading">
                <h2>Create a user</h2>
              </div>
              <form
                className="form-grid"
                onSubmit={onSubmit("/admin/users", (f) => ({
                  ...Object.fromEntries(f),
                  properties: f.getAll("properties"),
                }))}
              >
                <label>
                  Name
                  <input name="name" required />
                </label>
                <label>
                  Email
                  <input name="email" type="email" required />
                </label>
                <label>
                  Initial password
                  <input
                    name="password"
                    type="password"
                    minLength={12}
                    required
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  Role
                  <select name="role">
                    {roles
                      .filter(
                        (r) =>
                          r !== "platform_admin" ||
                          user.role === "platform_admin",
                      )
                      .map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                  </select>
                </label>
                <fieldset className="full">
                  <legend>Authorized properties</legend>
                  {user.properties.map((p) => (
                    <label className="checkbox-label" key={p.id}>
                      <input name="properties" type="checkbox" value={p.id} />
                      {p.name}
                    </label>
                  ))}
                </fieldset>
                <button disabled={busy} className="primary full">
                  Create user
                </button>
              </form>
            </section>
          )}
          <section className="panel">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {(section === "users"
                      ? ["Name", "Email", "Role", "Property grants"]
                      : section === "properties"
                        ? ["Property", "Organization", "Timezone"]
                        : ["Name", "ID"]
                    ).map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.data?.[section || ""] || []).map((r: any) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.name}</b>
                      </td>
                      {section === "users" ? (
                        <>
                          <td>{r.email}</td>
                          <td>
                            <Badge>{r.role}</Badge>{" "}
                          </td>
                          <td>
                            {r.properties.join(", ") || "No property access"}
                          </td>
                        </>
                      ) : section === "properties" ? (
                        <>
                          <td>{r.organization_id}</td>
                          <td>{r.timezone}</td>
                        </>
                      ) : (
                        <td className="mono">{r.id}</td>
                      )}
                      <td>
                        {(section !== "tenants" ||
                          user.role === "platform_admin") && (
                          <>
                            <button
                              disabled={
                                busy ||
                                (section === "users" && r.id === user.id)
                              }
                              onClick={() => setEditing(r)}
                            >
                              Edit
                            </button>
                            <button
                              disabled={busy}
                              onClick={() => setArchiving(r)}
                            >
                              Archive
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {section === "tenants" && (
              <p className="helper padded">
                This session manages its current tenant. Platform administrators
                can provision an isolated workspace and select it using the
                workspace selector.
              </p>
            )}
          </section>
        </State>
      )}
    </>
  );
}
