# Hospitality Operations Web V1

A working local V1 for daily hotel operations, multi-property oversight, and integration recovery. Built from an empty repository; no prototype was overwritten. Customer-facing default branding is **Hospitality Operations**, with a configurable tenant identity. Version **1.0.0**.

## Run the demo immediately

Requires Node.js 24 and npm. In PowerShell:

```powershell
npm.cmd ci
npm.cmd run demo
```

Open **http://localhost:5173**. The command creates an isolated, persistent embedded PostgreSQL database in `data/demo`, applies the SQL migration, seeds synthetic data, and prints a generated password. Login as `admin@demo.local`. Existing seed accounts retain their first password; set `DEMO_PASSWORD` consistently when reusing a database. The demo helper explicitly opts into PGlite; normal startup requires `DATABASE_URL`.

All seed accounts use the provided `DEMO_PASSWORD`:

| Account | Role | Initial access |
| --- | --- | --- |
| `admin@demo.local` | Group admin | Three demo properties |
| `platform@demo.local` | Platform admin + developer | Three demo properties; provision new tenants |
| `manager@demo.local` | Hotel manager | Jakarta |
| `frontoffice@demo.local` | Front office | Jakarta |
| `housekeeping@demo.local` | Housekeeping | Jakarta, without guest APIs |
| `it@demo.local` | IT | Three properties, integration tools, without guest APIs |
| `admin@other.local` | Different tenant | Separate demo data; no access to first tenant |

Every demo source is labeled. Demo adapter sync only verifies the local adapter; it never contacts Oracle or fabricates a live connection. Empty databases and users with no property grants are supported.

## PostgreSQL development

```powershell
Copy-Item .env.example .env
# Set DEMO_PASSWORD to a local password of at least 12 characters in .env.
docker compose up -d db
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

The default `.env.example` database URL matches the development Compose service. Use a different password before exposing any service. Do not seed a production database. `db:seed` explicitly refuses `NODE_ENV=production`; normal application startup never seeds.

API: http://localhost:3001/api/health. Frontend: http://localhost:5173. Interactive OpenAPI: http://localhost:3001/docs; machine-readable schema: `/docs/json`. Vite proxies `/api`, including WebSocket upgrades, to the backend.

## Run the full application with Compose

```powershell
# For the single-origin Compose app, set APP_ORIGIN=http://localhost:3001 in .env.
docker compose up --build -d
docker compose exec app npm run db:seed
```

Open **http://localhost:3001**. The same Fastify process serves the Vite build and API. Compose binds the app and database to loopback and persists PostgreSQL in a named volume. Migrations run on application startup under a database lock. Stopping services does not delete data.

## Working features

- Morning briefing with source timestamps; arrivals, departures, VIP and in-house counts drill into filtered reservations. Search by confirmation/guest name, arrival and status; paginated reservation detail.
- Rooms requiring attention and local housekeeping inspection; priority task creation, assignment, acknowledgment and completion. Changes are stored, audited and delivered to other browsers.
- Server-side command center grouped by the current tenant and authorized properties, organization/date filters, property comparison and alerts. Property links select the corresponding operational workspace.
- OCIM connection configuration per property/environment, encrypted credentials, request telemetry, correlation IDs, HTTP/latency/error classifications, safe read retries, bounded backoff and dead letters.
- Organizations, properties, users/roles/property grants, branding and audit trail. Editing access revokes existing sessions. Platform administrators can provision an empty tenant and switch only to tenants where they hold membership.
- Persistent React Router shell, lazy routes, skeleton/empty/error states, role-based menus, desktop/tablet/mobile layout, tenant app name/logo/favicon/color/title resolution.
- Native Fastify WebSockets: authenticated cookie + Origin + CSRF, fresh grant checks, scoped metadata without PII, heartbeat/ping, bounded buffers, sequence replay, reconnection, reconciliation, focus refetch and 30-second HTTP fallback.

## Oracle setup and limits

1. Create an **empty property** and grant the operator access. Demo and Oracle reservations cannot be mixed in a property; configuring the opposite source is rejected rather than deleting records.
2. Set `ENCRYPTION_KEY` to a cryptographically random 32-byte key encoded as 64 hex characters, stored outside source control. Retain it securely for decryption/rotation.
3. Set `OHIP_ALLOWED_HOSTS` to exact approved gateway hostnames. The adapter requires HTTPS, rejects URL credentials/extra paths/ports, and refuses redirects. TLS verification stays enabled.
4. In OHIP Connections, select Oracle, choose the actual environment, and supply its OCIM client ID/secret, application key, enterprise ID and hotel/chain mapping. Credentials are write-only and replaced on save.
5. Authorize the documented read operation in Oracle and inspect Integration Health and Request Logs. No real Oracle credentials or hotel access were supplied for this implementation.

The adapter uses the official `POST /rsv/v1/hotels/{hotelId}/reservations/searches` operation, with OCIM `/oauth/v1/tokens`, token reuse and one 401 refresh. Read-only semantics make this POST search safe to retry; arbitrary POST/mutation retries are not supported. API permissions remain controlled by Oracle. SSD/resource-owner authentication is not implemented.

The worker polls at least every 30 seconds (default 60), sends real requests at a configurable minimum spacing (default 250 ms per process), honors throttling `Retry-After`, and uses database leases plus `SKIP LOCKED`. Each job is bounded to 20 pages/search, 100 records/page, 1,000 cached IDs and an eight-minute deadline; exceeding a limit becomes a visible failure instead of a successful partial sync. Attempts stop after five and enter dead letters; authorized manual retry is audited. Configure intervals for the customer's API entitlement; multiple replicas require a shared outbound quota limiter before production.

Polling covers current arrivals, departures and in-house reservations, then reconciles cached operational IDs to catch reschedules/cancellations. Changed snapshots are upserted atomically with the checkpoint and event outbox. Repeated identical snapshots preserve their timestamps; returning to an older state is still applied. Search is over the ingested local read model; this is not an unlimited Oracle search/archive. Missing/deleted reservations require an agreed upstream reconciliation policy; absence is not interpreted as deletion.

Oracle Business Events/Streaming is **not enabled or claimed**. Enable a separately validated ingestion adapter only after the property's capability, permissions and consumer restrictions are known. Guest Profiles currently shows reservation guest summaries, not a full CRM profile feed. Room states/tasks are local operational data; Oracle room/profile writes and imports are not implemented. Date filters use reservation stay dates in the current read model; there are no historical KPI snapshots, and tasks/connection status reflect current state.

Contracts and synthetic mapping fixtures are validated against official Oracle tags **26.2**, **26.3**, and **v26.4**. The RSV specification bundled in v26.4 still declares version 26.3.0.0. This confirms fixture compatibility, not live hotel compatibility or production readiness. Sources and license are recorded in [fixtures/README.md](fixtures/README.md).

## Verify

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run test:browser
```

The browser smoke script requires an installed Chrome/Edge on Windows, or `CHROME_PATH` pointing to an installed Chromium executable; otherwise install the Playwright browser separately. It launches its own built application on port 3101, creates a fresh embedded PostgreSQL demo database, and closes its server/browser. Screenshots and structured results go to ignored `artifacts/`.

To repeat API/database/WebSocket tests against a **disposable local PostgreSQL** database, create a database whose name ends in `_test` and set `TEST_DATABASE_URL`. The suite creates a unique schema, runs the migration and seed there, and drops only that schema at teardown:

```powershell
$env:TEST_DATABASE_URL='postgres://hospitality:local-development-only@localhost:5432/hospitality_test'
npm.cmd test
Remove-Item Env:TEST_DATABASE_URL
```

See [docs/VALIDATION.md](docs/VALIDATION.md) for actual results, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries and deployment considerations, [docs/FILES.md](docs/FILES.md) for the source manifest, and [CHANGELOG.md](CHANGELOG.md).
