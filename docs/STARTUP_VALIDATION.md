# Startup change delivery — 2026-11-17

## Result and root cause

Implemented for future starts. Owner `.env` bind remains `192.168.1.122:3501`; owner DB/runtime was not migrated, reset, replaced or restarted. No production deployment, commit or push was performed.

Initial exact-URL browser navigation to `http://192.168.1.122:3501` returned `ERR_CONNECTION_REFUSED`. A separate disposable server on the same LAN interface reproduced the white screen: HTML returned successfully, but CSP `upgrade-insecure-requests` upgraded JS/CSS/favicon to HTTPS, causing `ERR_SSL_PROTOCOL_ERROR` and empty React root. The configured HTTP-origin path now avoids this upgrade; strict script CSP and production HTTPS/auth/cookie/CSRF/RBAC/OHIP requirements remain.

After the change, Edge rendered the login, authenticated shell and Housekeeping route. JS/CSS returned correct JavaScript/CSS MIME types (200 initially, valid 304 on reload); all API requests and WS URLs used the page origin. A connected authenticated WebSocket was verified. Desktop 1440×900 and mobile viewport 390×844 rendered; there were zero page exceptions and zero failed requests in the normal flow. A pre-login `/api/me` 401 remains expected. Forced React chunk failure displayed a visible recovery panel.

## Validation results

| Check | Result | Evidence |
| --- | --- | --- |
| Lint | PASS | `npm.cmd run lint` |
| TypeScript + frontend/server build | PASS | `npm.cmd run build` |
| All tests | PASS: 242 tests, 18 files | `artifacts/startup/unit-tests.txt` |
| Disposable real PostgreSQL | PASS: 37 tests, 3 files | `artifacts/startup/postgres-tests.txt` |
| LAN desktop/mobile viewport/auth/Housekeeping/error UI | PASS | `artifacts/startup/after-browser.json` and PNGs |
| Fresh compiled entry: all migrations before listen | PASS | `artifacts/startup/runtime-smoke.json` |
| Repeated compiled entry: skip applied migrations | PASS | Same runtime artifact |
| Concurrent startup lease | PASS | Same runtime artifact |
| One pending migration on next compiled start | PASS | Same runtime artifact |
| Explicit all-interface bind, reachable via LAN and loopback | PASS | Same runtime artifact; owner bind unchanged |
| Invalid bind IP / occupied port | PASS: nonzero, no READY | Same runtime artifact |
| DB unavailable / missing lazy frontend chunk | PASS: nonzero, no READY/fallback | Same runtime artifact |
| Graceful Windows owned-child shutdown | PASS: IPC, authenticated WS closed 1001 | Same runtime artifact |
| Embedded persistence and archive restore | PASS | Migration unit tests and PostgreSQL validation's embedded restore test |
| Zero/HTTP/WS/socket byte counters, units, scaling, TTY/non-TTY cleanup | PASS | Traffic tests; real HTTP/WS fixture sockets |
| OHIP dispatch/error counters, policy-block exclusion | PASS | OHIP read-only regression test; fake transport only |
| Real Windows PowerShell TTY display | PASS | Interactive tool execution: stdout/stderr TTY true; idle, actual local fixture HTTP request, readable error output and cleanup |
| Historical migrations 0004/0005 immutable | PASS | No SQL file diff; pinned SHA-256 hashes verified |

PostgreSQL validation used a unique labeled `postgres:17-alpine` container with an ephemeral loopback port and disposable schemas. It removed only that owned test container/volume. Runtime validation copied the built distribution under a unique `data/startup-runtime-*` workspace with its own `.env`, DB, lease and port; that workspace was removed. Browser verification used in-memory synthetic data. The compiled entry tested is the same `dist/server/index.js` invoked by `npm start`; the smoke invokes Node directly for graceful IPC ownership.

## Files changed

| Area | Files |
| --- | --- |
| Configuration/startup | `.env.example`, `apps/api/src/config.ts`, `apps/api/src/index.ts`, `apps/api/src/migrate.ts` |
| Existing DB workflow and policy | `apps/api/src/db.ts`, new `apps/api/src/startup-migrations.ts`, new `apps/api/src/migration-policy.ts` |
| Readiness/traffic/lifecycle | new `apps/api/src/startup-report.ts`, new `apps/api/src/traffic.ts`, `apps/api/src/app.ts`, `apps/api/src/ohip-policy.ts`, `apps/api/src/realtime.ts` |
| Frontend startup | `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/boot.tsx`, new `apps/web/src/bootstrap.ts` |
| LAN-compatible local UUIDs | new `apps/web/src/browser-id.ts`, `apps/web/src/useWorksheetAutosave.ts`, `apps/web/src/pages/ShiftControls.tsx` |
| Tests | `tests/config.test.ts`, `tests/ohip-read-only.test.ts`, new `tests/startup-migrations.test.ts`, new `tests/traffic.test.ts` |
| Disposable acceptance scripts | new `scripts/startup-browser-smoke.ts`, new `scripts/startup-runtime-smoke.mjs`, new `scripts/startup-postgres-validation.mjs` |
| Documentation | `README.md`, `CHANGELOG.md`, `docs/DEPLOYMENT.md`, new `docs/STARTUP.md`, new `docs/STARTUP_VALIDATION.md` |

`package-lock.json` already had local changes before this task; they were preserved. No historical migration SQL or application business tables were redesigned.

## Behavior and limits

The existing migrator now validates reviewed release checksums, preserves version history, records companion metadata/results/durations, applies allowed pending SQL atomically under locks, and checks required schema before HTTP. Embedded data uses a DB-managed recoverable export before pending work; production missing/invalid paths fail closed. The same workflow supports native embedded, native external PostgreSQL and Docker PostgreSQL. New companion tables are `schema_migration_metadata` and `schema_migration_attempts`; existing version rows and historical files remain unchanged.

The ready banner/JSON distinguishes actual runtime/database/network modes, stored integration state, listener readiness and browser-render acceptance. The native interactive meter measures accepted application-server socket deltas once for HTTP/WS, counts HTTP statuses/timing and WS activity, and tracks separate policy-enforced OHIP dispatches in 60-second buckets. Redirected/Docker startup remains ordinary structured output. No payloads, tokens, secrets, guest identities or request URLs are retained by the counters.

Migration safety limitations: legacy pre-checksum history can only receive an explicit reviewed-release baseline, not retroactive proof of original bytes/timestamps. Future auto SQL is deliberately restricted; complex changes require review. External PostgreSQL backup/PITR remains operator-managed, with no assumption pg_dump exists. Failed-attempt persistence is best effort after rollback/connection loss; startup still fails nonzero. Embedded backup retention and off-host copies are operator responsibilities. See [startup/backup procedures](STARTUP.md).

NOT TESTED: owner DB/application acceptance at port 3501 after maintenance restart; a real separate client device/firewall path; production HTTPS reverse proxy; live Oracle health/traffic; Docker application runtime; Windows Terminal as a separate host; human-generated PowerShell Ctrl+C. IPC graceful shutdown and a real PowerShell TTY were tested, and are reported separately.
