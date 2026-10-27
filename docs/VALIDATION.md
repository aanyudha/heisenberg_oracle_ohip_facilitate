# Validation — 2026-10-27 (Asia/Jakarta)

Validated locally on Windows, Node.js 24.14.1, npm 11.19.0, installed Chrome via Playwright, and a dedicated Docker Compose PostgreSQL 17 service. No Oracle customer credentials or production property were used.

| Gate | Actual result |
| --- | --- |
| `npm run lint` | PASS |
| `npm run build` (strict TypeScript + Vite) | PASS; lazy route chunks generated |
| `npm test`, embedded PostgreSQL | PASS — 44 tests across three files |
| `TEST_DATABASE_URL=… npm test`, real PostgreSQL 17 | PASS — same 44-test suite; API/database/WebSocket suite uses an isolated schema in a local `_test` database |
| `npm run test:browser` | PASS — real installed Chrome, isolated embedded PostgreSQL, built app |
| `npm audit` | PASS — 0 reported vulnerabilities at validation time |
| `docker compose config --quiet` | PASS |
| Compose Dockerfile build | PASS — Linux Node 24 image, npm ci and TypeScript/Vite build |
| Compose app and PostgreSQL health checks | PASS — both healthy |
| Compose empty database | PASS — migration 0001 present, zero users, zero reservations; no seed required for startup |
| HTTP smoke against Compose | PASS — `/api/health`, `/`, `/operations/reservations`, `/docs/json` return 200; unauthenticated `/api/me` returns 401 |
| Live Oracle OAuth/search/property ingestion | NOT TESTED — no authorized credentials/property supplied |
| Oracle Business Events / Streaming | NOT IMPLEMENTED / NOT ACTIVE — controlled polling is the supported fallback |
| Physical tablet/mobile browsers and Safari | NOT TESTED — responsive validation used Chrome viewports |
| Production deployment, HA, sustained load, backup/restore and security assessment | NOT TESTED — local V1 only |

The 44 tests consist of 25 API/database/WebSocket tests, 12 Oracle contract/adapter/crypto tests, and seven frontend/navigation/realtime tests. The PostgreSQL run repeats the same suite; it is not an additional 44 distinct cases.

API coverage includes cookie authentication, session/logout behavior, CSRF/Origin checks, role restrictions, tenant/property isolation, server-side aggregation, reservation pagination/search/detail, empty data/grants, task assignment validation/audit, room authorization, secret redaction, gateway allowlisting, safe/manual retry permissions, bounded backoff/dead letters, idempotent ingestion/checkpoints, tenant provisioning/switching, role/grant changes with session revocation, and OpenAPI request documentation. WebSocket tests verify cross-tenant/property exclusion, reconnect replay, foreign Origin rejection and logout revocation.

Oracle fixtures are validated by AJV against unmodified official schemas from Oracle tags 26.2, 26.3 and v26.4. OCIM token caching, one 401 refresh, no GET fallback, search body mapping, empty 204, throttling/Retry-After for token and reservation requests, TLS/network failure classification, cached-ID reconciliation, authenticated encryption/tamper detection, and matching sanitized correlation IDs are exercised with mocked transport. These do not prove compatibility with a particular customer's environment. The v26.4 RSV schema still identifies itself as 26.3.0.0; [source provenance](../fixtures/README.md).

Chrome smoke checks login/logout, reservation confirmation search/detail, task create/assign/acknowledge, a separate backend mutation appearing through WebSocket invalidation within five seconds, every customer menu route, desktop/tablet/mobile rendering, mobile navigation and horizontal-overflow absence. Exactly one top-level document request occurred across internal navigation, with zero page errors. Screenshots and a structured result are generated under ignored `artifacts/`:

- `dashboard-desktop.png` — 1440 × 1050 viewport, full-page capture.
- `dashboard-tablet.png` — 768 × 1024 viewport.
- `dashboard-mobile.png` — 390 × 844 viewport.
- `browser-result.json` — assertions and result.

Earlier verification exposed and corrected a public-branding authentication exemption that affected PUT, an Oracle VIP object/string mapping mismatch, and an OpenAPI union-type assertion in the test source. A browser run overlapped a Vite rebuild and lost old lazy assets; verification was rerun sequentially after the build completed. All PASS results above refer to successful reruns after the respective fixes.

Working local features and remaining integration boundaries are listed in the [README](../README.md). Local validation containers are stopped after verification; the named development volume and image are retained. No remote push or production configuration change was performed.
