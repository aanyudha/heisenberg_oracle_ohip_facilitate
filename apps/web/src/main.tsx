import React, { lazy, Suspense, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  NavLink,
  Route,
  Routes,
  Navigate,
  useLocation,
} from "react-router-dom";
import {
  LayoutDashboard,
  Building2,
  CalendarDays,
  ArrowDownToLine,
  ArrowUpFromLine,
  Users,
  DoorOpen,
  ListChecks,
  Layers,
  ChartNoAxesCombined,
  Bell,
  Plug,
  Activity,
  FileWarning,
  RotateCcw,
  Settings,
  Palette,
  ShieldCheck,
  Code2,
  LogOut,
  Menu,
  ChevronDown,
  Hotel,
} from "lucide-react";
import type { Branding } from "@hospitality/contracts";
import { canAdmin, canGuests, canIntegrate } from "@hospitality/contracts";
import { api, ApiError, setCsrf, useData, write } from "./api";
import { useRealtime } from "./realtime";
import { ErrorBoundary, Skeleton, ErrorPanel } from "./components";
import "./styles.css";
import { Context, type Workspace } from "./workspace";
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Operations = lazy(() => import("./pages/Operations"));
const Group = lazy(() => import("./pages/Group"));
const Integrations = lazy(() => import("./pages/Integrations"));
const Admin = lazy(() => import("./pages/Admin"));
const Developer = lazy(() => import("./pages/Developer"));
export function applyBranding(b: Branding) {
  document.title = b.appName;
  document.documentElement.style.setProperty("--brand", b.primary);
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (favicon) favicon.href = b.favicon || "/favicon.svg";
}
function Login() {
  const client = useQueryClient();
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <div className="login-art">
        <Hotel size={44} />
        <h1>
          A clearer view.
          <br />A better guest day.
        </h1>
        <p>
          One workspace for your people, properties,
          <br />
          and daily operations.
        </p>
        <small>HOSPITALITY OPERATIONS</small>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            await api("/login", {
              method: "POST",
              body: JSON.stringify({
                email: f.get("email"),
                password: f.get("password"),
              }),
            });
            await client.invalidateQueries({ queryKey: ["me"] });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">WELCOME BACK</span>
        <h2>Sign in to your workspace</h2>
        <p>Use your organization account to continue.</p>
        <label>
          Email address
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            placeholder="you@hotel.com"
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"} <span>→</span>
        </button>
        <p className="helper">
          Local demo accounts are documented in the README. Demo data never
          represents a live Oracle connection.
        </p>
      </form>
    </div>
  );
}
type NavItem = [string, string, React.ComponentType<{ size?: number }>];
export function Shell({ user }: { user: Workspace["user"] }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState(user.properties[0]?.id || "");
  const propertyId = user.properties.some((p) => p.id === selected)
    ? selected
    : user.properties[0]?.id || "";
  const [date, setDate] = useState(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: user.properties[0]?.timezone || "Asia/Jakarta",
    }).format(new Date()),
  );
  const [mobile, setMobile] = useState(false);
  const { state, lastSync } = useRealtime(user);
  const location = useLocation();
  useEffect(() => {
    applyBranding(user.branding);
    setCsrf(user.csrf);
  }, [user.branding, user.csrf]);
  useEffect(() => setMobile(false), [location.pathname]);
  const groups: { title: string; items: NavItem[] }[] = [
    { title: "WORKSPACE", items: [["/", "Dashboard", LayoutDashboard]] },
    {
      title: "HOTEL OPERATIONS",
      items: [
        ...(canGuests(user.role)
          ? ([
              ["/operations/reservations", "Reservations", CalendarDays],
              ["/operations/arrivals", "Arrivals", ArrowDownToLine],
              ["/operations/departures", "Departures", ArrowUpFromLine],
              ["/operations/guests", "Guest Profiles", Users],
            ] as NavItem[])
          : []),
        ["/operations/rooms", "Rooms & Housekeeping", DoorOpen],
        ["/operations/tasks", "Priority Tasks", ListChecks],
      ],
    },
    {
      title: "GROUP OPERATIONS",
      items: [
        ["/group/overview", "Multi-Property Overview", Layers],
        ["/group/comparison", "Property Comparison", ChartNoAxesCombined],
        ["/group/alerts", "Alerts", Bell],
      ],
    },
    ...(canIntegrate(user.role)
      ? [
          {
            title: "INTEGRATIONS",
            items: [
              ["/integrations/connections", "OHIP Connections", Plug],
              ["/integrations/health", "Integration Health", Activity],
              ["/integrations/logs", "Error Logs", FileWarning],
              ["/integrations/retries", "Retry Queue", RotateCcw],
            ] as NavItem[],
          },
        ]
      : []),
    ...(canAdmin(user.role)
      ? [
          {
            title: "ADMINISTRATION",
            items: [
              ["/admin/tenants", "Tenants", Building2],
              ["/admin/organizations", "Organizations", Layers],
              ["/admin/properties", "Properties", Hotel],
              ["/admin/users", "Users & Roles", Settings],
              ["/admin/branding", "Branding", Palette],
              ["/admin/audit", "Audit Trail", ShieldCheck],
            ] as NavItem[],
          },
        ]
      : []),
    ...(user.developer
      ? [
          {
            title: "DEVELOPER ONLY",
            items: [
              ["/developer/version", "Core Version", Code2],
              ["/developer/compatibility", "OHIP Compatibility", Plug],
            ] as NavItem[],
          },
        ]
      : []),
  ];
  return (
    <Context.Provider
      value={{ user, propertyId, date, selectProperty: setSelected }}
    >
      <div className="app-shell">
        <aside className={mobile ? "sidebar open" : "sidebar"}>
          <div className="brand">
            {user.branding.logo ? (
              <img src={user.branding.logo} alt="" />
            ) : (
              <span className="brand-mark">
                <Hotel size={23} />
              </span>
            )}
            <div>
              {user.branding.appName}
              <small>OPERATIONS WORKSPACE</small>
            </div>
          </div>
          <nav>
            {groups.map((g) => (
              <div className="nav-group" key={g.title}>
                <p>{g.title}</p>
                {g.items.map(([path, title, Icon]) => (
                  <NavLink end={path === "/"} to={path} key={path}>
                    <Icon size={17} />
                    <span>{title}</span>
                    {title === "Priority Tasks" && <span className="nav-dot" />}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-footer">
            <span className="avatar">
              {user.name.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <b>{user.name}</b>
              <small>{user.role.replaceAll("_", " ")}</small>
            </div>
            <button
              aria-label="Sign out"
              onClick={async () => {
                await write("/logout", {});
                setCsrf("");
                client.removeQueries({
                  predicate: (q) => q.queryKey[0] !== "me",
                });
                await client.resetQueries({ queryKey: ["me"] });
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header>
            <button
              className="mobile-menu"
              aria-label="Toggle navigation"
              onClick={() => setMobile(!mobile)}
            >
              <Menu />
            </button>
            <div className="property-switch">
              <Building2 size={19} />
              <select
                aria-label="Property"
                value={propertyId}
                onChange={(e) => setSelected(e.target.value)}
              >
                {user.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </div>
            <div className="header-right">
              {(user.tenants?.length || 0) > 1 && (
                <select
                  aria-label="Workspace"
                  value={user.tenantId}
                  onChange={async (e) => {
                    await write("/switch-tenant", { tenantId: e.target.value });
                    client.removeQueries({
                      predicate: (q) => q.queryKey[0] !== "me",
                    });
                    await client.resetQueries({ queryKey: ["me"] });
                  }}
                >
                  {user.tenants?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              )}
              <label className="date-control">
                <CalendarDays size={16} />
                <input
                  type="date"
                  aria-label="Business date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </label>
              <span className={"connection " + state.toLowerCase()}>
                <i />
                {state}
              </span>
              <span className="avatar small">
                {user.name.slice(0, 2).toUpperCase()}
              </span>
            </div>
          </header>
          <main>
            <div className="sync-strip">
              <span>
                OPERATIONS /{" "}
                {location.pathname === "/"
                  ? "MORNING BRIEFING"
                  : location.pathname.split("/")[1]?.toUpperCase()}
              </span>
              <span>
                Last successful sync{" "}
                {lastSync ? new Date(lastSync).toLocaleTimeString() : "—"}
              </span>
            </div>
            <ErrorBoundary key={location.pathname}>
              <Suspense fallback={<Skeleton />}>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/operations/:section" element={<Operations />} />
                  <Route path="/group/:section" element={<Group />} />
                  <Route
                    path="/integrations/:section"
                    element={
                      canIntegrate(user.role) ? (
                        <Integrations />
                      ) : (
                        <Navigate to="/" />
                      )
                    }
                  />
                  <Route
                    path="/admin/:section"
                    element={
                      canAdmin(user.role) ? <Admin /> : <Navigate to="/" />
                    }
                  />
                  <Route
                    path="/developer/:section"
                    element={
                      user.developer ? <Developer /> : <Navigate to="/" />
                    }
                  />
                  <Route path="*" element={<Navigate to="/" />} />
                </Routes>
              </Suspense>
            </ErrorBoundary>
            <footer>
              Hospitality Operations{" "}
              <span>Secure workspace · Authorized properties only</span>
            </footer>
          </main>
        </div>
      </div>
    </Context.Provider>
  );
}
export default function App() {
  const me = useData<Workspace["user"]>(["me"], "/me");
  const branding = useData<Branding>(["branding-public"], "/branding");
  useEffect(() => {
    if (branding.data && !me.data) applyBranding(branding.data);
  }, [branding.data, me.data]);
  if (me.isPending) return <Skeleton />;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401)
      return <Login />;
    return (
      <ErrorPanel message={me.error.message} retry={() => void me.refetch()} />
    );
  }
  if (!me.data) return null;
  setCsrf(me.data.csrf);
  return <Shell user={me.data} />;
}
