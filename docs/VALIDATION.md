# Validation — centralized configuration and deployment

Executed locally on 2026-10-27 (Asia/Jakarta), Windows / Node.js 24.14.1, Chromium browser through Playwright, Docker Desktop Linux containers, and PostgreSQL 17. This report describes the configuration changes in the current source tree.

| Check | Result | Evidence |
| --- | --- | --- |
| Install | PASS | `npm.cmd install --offline --no-audit --no-fund`; existing dependency versions retained. This command did not perform a vulnerability audit. |
| Lint | PASS | `npm.cmd run lint` |
| Build | PASS | `npm.cmd run build`: TypeScript, React assets, Fastify bundles and migrations |
| Regression tests | PASS | `npm.cmd test`: 95 tests in 9 files, including configuration validation, OCIM OAuth/cache, six-field forms, shared/dedicated assignments, tenant/property isolation, credential preservation, migration rollback, embedded persistence and stale-lock recovery |
| Actual npm start | PASS | Compiled Fastify started in native/PostgreSQL mode using the existing local .env, connection=ready; `/api/health` returned ok and SPA returned HTTP 200 on port 3000 |
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

## OHIP OCIM refactor acceptance

The final regression suite passed both with embedded test databases and against an actual isolated PostgreSQL 17 server. The PostgreSQL run used a unique schema per API/migration suite in a database explicitly ending in `_test`; credentials with special characters were encoded for the test-only URL. Application connections continue to use separate driver parameters.

| OCIM check | Result | Evidence |
| --- | --- | --- |
| Six-field form | PASS | React tests and the built browser UI expose only baseUrl, clientId, clientSecret, appKey, enterpriseId, hotelId; no chain/scope/environment credential inputs |
| OAuth | PASS | Correct client-credentials body, backend scope, Basic authentication, enterpriseId and app-key headers against fake Oracle transport |
| Shared token cache | PASS | Distinct Hotel IDs reuse one connection token; concurrent/expiry/401 refresh and tenant/credential-revision isolation verified |
| Shared/dedicated credentials | PASS | Distinct property Hotel IDs share one credential record; different credentials create a dedicated record; concurrent identical creates are deduplicated |
| Property validation | PASS | Hotel access is checked before activation; wrong Hotel ID or OAuth credentials preserve the existing assignment |
| Access isolation | PASS | Role/property/tenant checks and composite tenant foreign keys verified, including restricted edits to shared credentials |
| Secret preservation | PASS | Blank edit fields retain stored ciphertext; encrypted values survive migration; secrets are absent from list/audit responses |
| Safe migration | PASS | Legacy assignments and chain history preserved, deduplication restricted to tenant, idempotent rerun, wrong-key transaction rollback tested on both engines |
| Operational routing | PASS | Polling uses assigned canonical credentials and mapped Hotel ID; results from an obsolete in-flight assignment are rejected |
| Existing deployment | PASS | Native and Docker SPA/REST/WebSocket, restart recovery, real PostgreSQL volume persistence and all existing regressions remain passing |

No live Oracle connection was used for acceptance. The configured local development database had no legacy real OHIP credential records to backfill; existing credential preservation was exercised using synthetic legacy records on both embedded and real PostgreSQL. No remote push or production deployment was performed. See [OHIP migration and API details](OHIP_OCIM.md).

`npm run test:deployment` automates the deployment matrix. Its test credentials are generated independently of the user's secrets. It temporarily changes root `.env`, restores the original in finally, and removes only its uniquely named test containers and volumes. Application data and original credentials are not reset. The standalone browser test also restores `.env` after its native test.

Ignored evidence files:

- `artifacts/config-deployment-result.json`
- `artifacts/browser-native-embedded-result.json`
- `artifacts/browser-native-postgres-result.json`
- `artifacts/browser-docker-result.json`
- `artifacts/dashboard-desktop.png`, `dashboard-tablet.png`, `dashboard-mobile.png`

All three browser runs use the same built frontend. They verify nested SPA route refresh, missing API/assets behavior, no document reload/WebSocket interruption during internal navigation, restart recovery, and subsequent realtime mutations. Existing tenant/property scoping, authentication, role permissions, retry handling, WebSocket authorization/replay, frontend states and Oracle fixtures remain covered by regression tests.

OHIP migration 0002 adds normalized connection/assignment tables and a transactional credential backfill; historical chain columns and existing business rows are preserved. Live OPERA/OHIP connectivity, production TLS infrastructure, HA/load and real backup/restore operations are not validated by these local tests. No push or production deployment was performed. See [deployment details](DEPLOYMENT.md) and [README](../README.md).
