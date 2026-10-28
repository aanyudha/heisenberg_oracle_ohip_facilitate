# Strict OHIP read-only validation - 2026-10-28

All checks below were performed locally. Oracle responses are mocked by default; no mutating request or test reservation was sent to a customer Oracle gateway. The original configured database and saved credentials were not changed for these tests.

| Check | Result | Evidence |
| --- | --- | --- |
| npm install | PASS | Offline installation, no dependency changes; no vulnerability audit claimed |
| Lint / build | PASS | npm run lint; strict TypeScript + Vite + compiled Fastify build |
| Regression suite | PASS | 130 tests / 10 files, retaining all 95 prior cases; same suite passes against isolated PostgreSQL schemas |
| Operation policy | PASS | Approved GET flags, bounded search POST and OAuth accepted; unknown/mutating operations, GraphQL, unsafe GET variants and method/body overrides denied before transport |
| Authorization | PASS | Tenant/property/connection/Hotel ID mismatch, gateway mismatch, missing/false authorization and revocation before dispatch/cache access rejected |
| Direct API enforcement | PASS | Oracle/proxy namespaces and business-write API attempts return 403 OHIP_READ_ONLY_POLICY with zero outbound calls |
| Polling / cache | PASS | Default worker uses only the approved client operations; dedup/cache remains scoped; stale-data detection verified |
| Operational UI | PASS | OHIP READ ONLY visible; no task creation/assignment/status or housekeeping write controls; six-field Connection Manager retained |
| Actual npm start | PASS | Started with an isolated empty embedded database, checked health and nested SPA, and confirmed local proxy/write attempt returns 403 |
| Native embedded / native PostgreSQL / Docker | PASS | 19 deployment checks; same built frontend, authenticated WebSocket updates/reconnect, task-history/session persistence and six-field connection UI |
| PostgreSQL durability | PASS | Test DB container recreated while keeping its volume; stored task history retained |
| Config / resources | PASS | Root .env restored with strict flags; no credential rotation; isolated test containers/volumes cleaned |

The browser harness now simulates internal DEMO history/cache changes through authenticated local fixture APIs to verify realtime and durability. It does not reintroduce operational write controls or call Oracle. Legacy local task/room writes are rejected for Oracle-mapped properties.

Exact allowed endpoints, blocked endpoint families, OAuth local alias, GET side-effect restrictions and classification limits are documented in [OHIP_READ_ONLY_POLICY.md](OHIP_READ_ONLY_POLICY.md). No live Oracle acceptance, production deployment or remote push is claimed.

---

The earlier configuration/OCIM verification below is historical; its task-edit UI coverage predates removal of those operational controls.

# Validation — centralized configuration and deployment

Executed locally on 2026-10-27 (Asia/Jakarta), Windows / Node.js 24.14.1, Chromium browser through Playwright, Docker Desktop Linux containers, and PostgreSQL 17. Historical report for the configuration/OCIM changes before strict read-only UI enforcement.

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
