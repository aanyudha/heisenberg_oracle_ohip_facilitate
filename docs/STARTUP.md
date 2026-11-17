# Startup, migration safety and traffic dashboard

[Delivery report, changed files, PASS/NOT TESTED matrix and evidence](STARTUP_VALIDATION.md).

## Run after building

```powershell
npm.cmd run build
npm.cmd start
```

Only restart an operational instance during an authorized maintenance window. Development and verification scripts described here use disposable databases and separate ports; they do not edit the owner's root `.env`, acquire its deployment lease, migrate its database, or restart it.

Existing LAN configuration remains:

```dotenv
APP_MODE=native
APP_HOST=192.168.1.122
APP_PORT=3501
APP_URL=http://192.168.1.122:3501
NODE_ENV=development
COOKIE_SECURE=false
DB_MIGRATION_MODE=auto
STARTUP_DASHBOARD=auto
TRAFFIC_METER_ENABLED=true
TRAFFIC_METER_INTERVAL_MS=1000
```

`APP_HOST` selects the native listener IP. `APP_URL` selects the actual browser origin used by origin/CSRF checks. Binding to the LAN IP does not bind localhost. `APP_HOST=0.0.0.0` is an explicit optional all-IPv4-interface binding; keep APP_URL at the real browser URL. Docker always binds `0.0.0.0` internally, while Compose's published port remains loopback behind a reverse proxy. Production network origins still require HTTPS and secure cookies.

## LAN white-screen diagnosis

The disposable pre-fix Edge reproduction loaded HTTP HTML but CSP `upgrade-insecure-requests` upgraded its JS/CSS/favicon to HTTPS. Those requests failed with `ERR_SSL_PROTOCOL_ERROR`; `#root` was empty. HTTP 200 was therefore insufficient evidence. The configured HTTP origin now omits that upgrade directive and the HTTPS-only opener header; HTTPS deployments retain them. Strict same-origin script CSP remains, with no `unsafe-eval`, and auth, RBAC, cookies, CSRF and Oracle guards remain active.

The browser uses same-origin `/api` fetches and derives `ws:`/`wss:` and host from the page URL. No browser production API points at localhost or an alternate port. The Vite localhost:3000 proxy is for the separate optional development server, not the compiled single-port `npm start` deployment.

An independent bootstrap displays a recovery message if React modules fail to load. Static HTML includes a useful loading/recovery message even if the bootstrap itself cannot load. A root ErrorBoundary covers render failures. Cryptographic local operation/shift UUID generation works over HTTP LAN through `crypto.getRandomValues`; authentication tokens and CSRF generation are unchanged.

The exact owner URL `http://192.168.1.122:3501` returned connection refused during the initial browser check. It was not restarted. Positive browser proof uses that same LAN interface on separate ephemeral test ports. This is same-machine LAN-address testing, not cross-device acceptance.

## One migration workflow

Native embedded, native PostgreSQL, Docker PostgreSQL and the migration CLI call the same extended `migrate()` implementation; no competing migration system is introduced. Startup validates configuration and the Vite manifest/assets, acquires the existing deployment lease, opens the selected DB, checks connectivity, checks history/checksums, backs up embedded data when required, applies allowed pending migrations, verifies schema, and only then starts Fastify/WebSocket and prints READY.

- Historical SQL 0001–0006, including 0004/0005, remains unchanged. SHA-256 release baselines normalize CRLF/LF only. Editing a historical file fails startup even on a fresh DB.
- Existing `schema_migrations(version)` rows are preserved. `schema_migration_metadata` adds version, name, checksum, applied timestamp, recorded timestamp, execution result, duration and legacy-baseline provenance. No already-applied SQL is replayed.
- Old databases have no historical checksum or timestamp evidence. They receive companion `LEGACY BASELINE` records only for exact reviewed release files; original applied timestamps/durations remain unknown/null. This establishes future tamper detection and cannot prove which bytes were used before checksum tracking existed.
- `schema_migration_attempts` records successful work and best-effort failed/rolled-back attempts without SQL bodies or secrets. First-ever rollback can also roll back creation of that audit table; connection loss can prevent failure persistence. The process still reports failure and exits nonzero.
- Migrations run in one transaction under PostgreSQL advisory lock with bounded lock/statement waits. Competing PostgreSQL instances recheck history after acquiring the lock. Embedded opens hold an additional heartbeat lease beside the canonical DB path, including across checkouts; snapshots stay outside this lease directory.
- Unknown/gapped history, duplicates, version gaps, checksum mismatches, missing required columns and SQL failures stop startup before HTTP. Pending failures roll back all pending SQL/history, allowing a safe retry after the cause is corrected.
- New automatic SQL intentionally accepts only a small conservative subset: simple CREATE TABLE with primitive columns, simple non-unique CREATE INDEX, and nullable primitive ADD COLUMN. DML, drops/truncation, procedural SQL, executable defaults, new foreign keys/unique indexes and risky changes are blocked. More complex migrations need explicit design/review and a maintained policy; auto is not a general SQL safety analyzer. Reviewed historical backfill behavior is unchanged.
- Production embedded paths must already contain valid data; missing, empty or invalid paths fail instead of initializing a replacement DB. Intentionally provision a new embedded instance in development with its chosen path before switching to production. PostgreSQL never creates a missing configured database or falls back to embedded.

The DB role needs USAGE/CREATE on the application schema plus permissions to read history and alter relevant application tables. Errors expose safe SQLSTATE/network codes and actionable explanations, not credential-bearing driver queries. No schema compatibility assertion is made until the migration transaction succeeds.

## Embedded backup and recovery

Before pending SQL or legacy metadata enrollment, persistent PGlite calls its synchronized `dumpDataDir('gzip')` API and writes an exclusive `pre-migration-<time>-<id>.tar.gz` archive under a `migration-backups` directory beside DB_FILE. An export/write failure stops startup. The implementation never copies an active DB directory. A restore test verifies a real exported archive contains the pre-migration version and existing records.

Keep archives protected: they contain application data and encrypted credentials. Preserve the original ENCRYPTION_KEY. Retention/space monitoring and off-host copies remain operator responsibilities; the application does not silently delete backups.

To restore, stop the relevant instance first. Restore to a **new, explicitly selected recovery directory**, never over live files. With the installed PGlite version, load the archive using `new PGlite({ dataDir: recoveryPath, loadDataDir: new Blob([archiveBytes]) })`, wait for readiness, verify schema/history and records, then close the recovery DB. Only after verification should an operator change DB_FILE during maintenance. Keep the original directory and key until recovery is accepted. The automatic test restores into a separate in-memory DB and compares its retained record/version.

## PostgreSQL backups

Startup preserves the configured external/server DB and does not create a replacement. Auto migrations are transactional and restricted, but a transaction is not a disaster-recovery backup. Maintain and verify server-managed backups/PITR or an operator-managed consistent logical backup before application upgrades. If `pg_dump` is installed and compatible with the server, use an administrator-selected output destination and credential-safe mechanism such as a protected password file; avoid passwords in command lines. Otherwise use the existing database backup service/tooling. The application neither assumes pg_dump exists nor claims to have backed up external PostgreSQL automatically.

## Readiness and terminal traffic

READY follows successful HTTP listen. Reports identify deployment mode, runtime environment, application version, DB engine/connection type, migration status/version, actual bind/port and APP_URL. Frontend asset readiness is distinct from browser rendering; WebSocket listener readiness is distinct from connected clients. Integration reporting shows configured connections, polling-eligible/paused assignments and last stored real sync, explicitly without claiming live connectivity. Status is refreshed with worker activity at most once per 30 seconds, not by a DB query every meter tick.

Native interactive stdout/stderr TTY with auto dashboard and enabled meter gets an in-place five-line display. Normal stdout/stderr writes remove the meter first, keeping errors readable; the next tick redraws it. It never clears the whole terminal. Redirected output, services and Docker receive one structured startup report and normal logs, without ANSI animation or repeated idle lines. `off` disables dashboard animation; `false` disables the traffic meter. Interval range is 250–60000 ms.

- **APPLICATION SERVER TRAFFIC** measures `bytesRead`/`bytesWritten` deltas on accepted application-server sockets, including HTTP headers and WebSocket frames exactly once. It excludes OHIP/client sockets and all other Windows/LAN/NIC traffic.
- IN/OUT bars automatically scale to a labeled power-of-two full scale, minimum 1 KB/s; KB=1024 bytes, MB=1024² bytes. Idle rates are zero.
- HTTP request rate and average response time are per-sample; 2xx/4xx/5xx counts are cumulative for this Node process. WS counts include accepted connections, send/receive messages, and per-interval connection/disconnection activity.
- OHIP request/error counters use actual dispatch at the existing policy-enforced HTTP layer, in bounded 60-second buckets. Cache hits and policy-blocked attempts do not count as upstream traffic. No URL, query string, body, token, secret or guest identity is retained by the meter.
- Shutdown stops refresh/worker timers, closes authenticated WS clients with 1001, drains reconciliation/owned work, closes HTTP/DB and releases owned leases. Windows disposable runtime proof uses graceful IPC; it does not misrepresent `process.kill(..., 'SIGINT')` as a real console Ctrl+C event.

## Disposable validation

```powershell
npm.cmd run lint
npm.cmd run build
npm.cmd test
node --import tsx scripts/startup-browser-smoke.ts
node scripts/startup-runtime-smoke.mjs
node scripts/startup-postgres-validation.mjs
```

Browser smoke uses Edge, an in-memory PGlite fixture, compiled frontend assets and an ephemeral listener on 192.168.1.122. Runtime smoke copies the compiled distribution into a unique disposable workspace under data/, uses its own `.env`, DB/leases and port, and removes only that workspace. PostgreSQL validation uses a locally available image, a unique labeled container and loopback ephemeral port; it verifies ownership before removing only its container/volume. It does not pull images or change the owner's Compose deployment.

Artifacts under `artifacts/startup/` include the pre-fix screenshot/errors, post-fix desktop/login, authenticated Housekeeping, mobile viewport and forced-bootstrap-error screenshots, asset types, root content, API/WS origins, compiled repeated-start/shutdown/bind-conflict results, and PostgreSQL test output. A pre-login `/api/me` 401 in the browser console is expected; it is not a React exception or a failed asset.

Not covered by same-machine fixtures: a real separate client device/firewall path, production HTTPS reverse proxy, real Oracle health/entitlement, Docker application runtime, or a human PowerShell Ctrl+C event. Source historical checksums and all owner data/settings are preserved.
