# Changelog

## Unreleased - Local UI actions and connection lifecycle (2026-10-29)

- Replaced reservation detail action columns with accessible clickable rows and native read-only dialogs; room cards open cached read-only details.
- Added local tenant/organization/property edit/archive, membership archive, and branding reset with confirmation, RBAC, tenant scope, dependency checks, last-administrator protection and transactional audit events.
- Added administrator connection/property Stop/Resume and global Archive, affected-property confirmation, persistent pause flags, scheduler/enqueue/retry guards and centralized outbound dispatch locking.
- Kept cached data available as Stale while paused, rejected results racing pause/resume using assignment revisions, and separated browser WebSocket, OHIP lifecycle and property freshness indicators.
- Preserved the selected property and mounted SPA through transient identity refetch failures during Docker restart; authentication failures still return to login.
- Added migration 0003 without changing stored credentials or deleting audit history; expanded UI, lifecycle, persistence, isolation and local CRUD regressions. No Oracle mutation endpoint, push or production deployment.

## Unreleased - Strict OHIP read-only V1 (2026-10-28)

- Locked backend configuration to OHIP_ACCESS_MODE=read_only and OHIP_MUTATIONS_ENABLED=false, with safe defaults and startup rejection of any enabling value.
- Centralized outbound HTTP policy validates approved operation identity, exact method/path/headers/body semantics, assigned gateway, tenant/property/connection/Hotel ID and fresh server-side authorization before dispatch. Unknown operations default to HTTP 403 OHIP_READ_ONLY_POLICY.
- Retained OCIM authentication and bounded POST reservation search; approved only the explicitly side-effect-disabled getReservation GET shape. All mutations, GraphQL and arbitrary Oracle/proxy requests remain blocked.
- Removed task/housekeeping write controls and related-task creation from operational UI, added OHIP READ ONLY and an in-house guest navigation link, and kept local administrative connection management.
- Restricted legacy task/room mutation APIs to local non-Oracle/demo properties for backwards compatibility and fixture tests; no legacy API forwards an Oracle write.
- Preserved polling, OAuth refresh, encrypted credentials and scoped WebSocket notifications; added bounded scoped response caching/deduplication, immediate authorization rechecks, and per-property snapshot freshness. Workspace events are no longer labeled Oracle syncs.
- Added policy, direct-API, polling, stale-data and read-only UI regressions without removing the existing 95 tests. No stored credentials or database schema changed; no live Oracle mutation was used for testing.


## Unreleased - OHIP OCIM Connection Center (2026-10-27)

- Replaced the connection form with exactly six parameters: baseUrl, clientId, clientSecret, appKey, enterpriseId and hotelId. Removed Chain Mapping and additional required mode/environment/scope inputs.
- Added tenant-scoped credential records and property-specific Hotel ID assignments, shared/dedicated connection flows, edit with blank-secret preservation, property access testing before activation, assigned properties, health and last-connected status.
- Added transactionally locked migration 0002 with encrypted credential backfill, per-tenant deduplication, original assignment preservation, encryption-key failure rollback and retained historical chain fields. Legacy encrypted blobs are cleared only after successful normalized storage within the same transaction.
- Added OCIM token sharing across a connection's Hotel IDs, concurrent refresh coordination, early expiry and one 401 re-authentication. The backend owns the official scope; no refresh-token or resource-owner grant is used.
- Operational requests resolve tenant/property/connection/Hotel ID from authorized persisted assignments. Credential or assignment changes invalidate adapter routing; stale in-flight poll results are discarded.
- Preserved gateway HTTPS allowlisting, redirect rejection, AES-GCM encryption, tenant/property RBAC, sanitized telemetry, audit events, demo operation and single-port native/Docker deployment.
- Added connection, form, migration, OAuth cache and isolation regression coverage; deployment validation runs the suite against real PostgreSQL in isolated schemas and verifies the six-field form in a browser.


## Unreleased — single-server deployment

- Native deployment now uses `npm install`, `npm run build`, `npm start`; backend JavaScript, React assets and migrations are emitted into `dist/` and served by one Fastify on configurable port 3000.
- Added persistent embedded support and explicit first-run-only sample initialization, transactional migration locking, and validated production settings with no production seeding.
- Replaced the development-style Dockerfile with separate build/runtime stages and runtime-only dependencies; Compose waits for PostgreSQL, keeps data in its named volume, publishes only the app port, and adds restart policies.
- Preserved scoped native WebSockets, SPA routing, branding and all operational features. Added browser verification of nested-route reload, navigation without socket replacement, reconnect, and task/session persistence across restart in both deployment modes.
- Simplified README to two mutually exclusive deployment methods and moved detailed operations/configuration material into focused documents.

## 1.0.0 — 2026-10-27

- Bootstrapped an empty repository into npm workspaces: Fastify/TypeScript, React/Vite, shared contracts, PostgreSQL via Drizzle.
- Added scoped operational dashboards, reservation search/detail, guest summaries, housekeeping, and task creation/assignment/acknowledgment.
- Added server-side multi-property summaries, comparison, and actionable alerts.
- Added cookie sessions, CSRF, role permissions, property grants, AES-GCM secret storage, safe error handling, and administrator audit trail.
- Added authenticated Fastify WebSocket notifications, persisted sequences, replay/reconciliation, reconnect backoff, focus refetch, and polling fallback.
- Added OCIM read-only adapter, official Oracle contract fixtures for tags 26.2 / 26.3 / v26.4, bounded safe retry, checkpoints, request telemetry, and dead-letter recovery.
- Added clearly labeled demo seed, embedded local demo option, Docker Compose, migrations, setup and deployment documentation, and automated tests.
- Oracle live credentials, streaming, production deployment, and device/browser visual validation remain separate acceptance gates; see README and validation report.
