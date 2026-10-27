# Validation — centralized configuration and deployment

Executed locally on 2026-10-27 (Asia/Jakarta), Windows / Node.js 24.14.1, Chromium browser through Playwright, Docker Desktop Linux containers, and PostgreSQL 17. This report describes the configuration changes in the current source tree.

| Check | Result | Evidence |
| --- | --- | --- |
| Install | PASS | `npm.cmd install --offline --no-audit --no-fund`; existing dependency versions retained. This command did not perform a vulnerability audit. |
| Lint | PASS | `npm.cmd run lint` |
| Build | PASS | `npm.cmd run build`: TypeScript, React assets, Fastify bundles and migrations |
| Regression tests | PASS | `npm.cmd test`: 79 tests in 5 files, including configuration validation, embedded reopen/idempotent migrations and concurrent stale-lock recovery |
| Actual npm start | PASS | Compiled Fastify started in native/embedded mode, connection=ready; `/api/health` returned ok and SPA returned HTTP 200 on port 3000 |
| Native embedded | PASS | Browser login/logout, all menu routes, SPA navigation, authenticated WebSocket updates, process restart, session/task persistence and realtime reconnect |
| Native PostgreSQL | PASS | Same browser assertions against an isolated PostgreSQL server reached through loopback, using a password with special characters |
| Docker PostgreSQL | PASS | Actual `docker compose up --build -d --wait` in an isolated project; configuration preflight, database and app healthchecks, same browser assertions and app-container restart |
| Database durability | PASS | PostgreSQL task-data fingerprint unchanged after recreating the DB container while retaining its named volume |
| Invalid configuration | PASS | Invalid APP_MODE/DB_TYPE, PostgreSQL empty password, malformed ports/hosts/identifiers, unknown settings and invalid security settings rejected |
| Missing .env | PASS | Compiled CLI returns setup instructions before database/listener initialization |
| Real database failures | PASS | Incorrect PostgreSQL password rejected with authentication guidance; unavailable connection rejected with connection guidance |
| Command/mode mismatch | PASS | Native command rejects Docker mode, and a real container rejects native mode |
| Concurrent deployments | PASS | Shared data-directory lock rejects native startup while Docker is active, including a different APP_PORT |
| Compose credentials | PASS | Special-character password shared between DB and app; mismatched shell interpolation rejected by preflight |
| PostgreSQL exposure | PASS | Actual inspected Compose database container has no host port binding |
| HTTP secret boundary | PASS | Browser checks root `.env` request, health, branding and OpenAPI responses for runtime secrets; no secret returned |
| Startup logs | PASS | Name, deployment, DB type, port and ready status present; test DB and demo passwords absent |

`npm run test:deployment` automates the deployment matrix. Its test credentials are generated independently of the user's secrets. It temporarily changes root `.env`, restores the original in finally, and removes only its uniquely named test containers and volumes. Application data and original credentials are not reset. The standalone browser test also restores `.env` after its native test.

Ignored evidence files:

- `artifacts/config-deployment-result.json`
- `artifacts/browser-native-embedded-result.json`
- `artifacts/browser-native-postgres-result.json`
- `artifacts/browser-docker-result.json`
- `artifacts/dashboard-desktop.png`, `dashboard-tablet.png`, `dashboard-mobile.png`

All three browser runs use the same built frontend. They verify nested SPA route refresh, missing API/assets behavior, no document reload/WebSocket interruption during internal navigation, restart recovery, and subsequent realtime mutations. Existing tenant/property scoping, authentication, role permissions, retry handling, WebSocket authorization/replay, frontend states and Oracle fixtures remain covered by regression tests.

Business schema and migration SQL are unchanged. Live OPERA/OHIP connectivity, production TLS infrastructure, HA/load and real backup/restore operations are not validated by these local tests. No push or production deployment was performed. See [deployment details](DEPLOYMENT.md) and [README](../README.md).
