# Changelog

## Unreleased - Startup reliability and LAN diagnostics (2026-11-17)

- Fixed the reproduced LAN HTTP blank screen: HTTP origins no longer receive HTTPS asset-upgrade directives. Kept strict script CSP, authentication, origin/CSRF/cookie checks and production HTTPS requirements. Added bootstrap failure UI and root React error boundary; local shift IDs use cryptographic UUID fallback on LAN HTTP.
- Extended the existing startup migrator with immutable historical checksums, conservative additive SQL policy, transaction/advisory locks, companion metadata/results/durations, legacy baseline provenance, schema readiness checks and DB-managed recoverable embedded backups. No historical SQL files were edited. Missing/invalid production embedded data paths fail closed.
- Added ready-only application/database/network/integration reporting and optional in-place native TTY traffic dashboard. Socket byte deltas include HTTP/WebSocket without double counting; OHIP dispatch/error counters remain separate. Redirected/Docker startup uses structured JSON.
- Added disposable migration/traffic/runtime/browser verification and deployment documentation. Preserved application modules, data, Housekeeping, Telephone, authentication/RBAC and OHIP strict read-only. Owner runtime/database and production deployment were not changed.

## Unreleased - Housekeeping operational refinement (2026-11-13)

- Added HK job classification to existing User Management, reusing identity/property grants and Housekeeping metadata. Removed staff role editing from Housekeeping configuration and closed its legacy write API (410); classification and explicit property authorization edits now use User Management RBAC and a shared classification service.
- Added inline property shift configuration and batch Manage Shift Staff. Explicit date/shift roster is required; removing staff with work/coverage returns a conflict. Additive migration 0006 adds shift active status without editing migrations 0004/0005.
- Added combined room search/filtering, bounded visible cards, retained selections with visible/matching/hidden counts, confirmed all-matching selection and desktop range selection. Occupancy uses only documented OPERA front-office status, with unknown values left unknown.
- Added deterministic Equal Rooms/Balanced Credits distribution, explicit missing-credit fallback, preview of existing/resulting workloads, one atomic distribution command and whole-batch undo, with current roster/scope/revision checks.
- Added canonical saved print/reconciliation API, explicit selected/all supervisor/attendant scope, pre-print revision/snapshot checks and report footer provenance. Kept browser-only A4 print, repeating headers and signatures.
- Added isolated 120-room / 3-supervisor / 12-attendant / 2-shift fixtures and API/frontend/browser/PDF regressions. Preserved OHIP read-only, historical assignments, Fastify WebSocket, SPA and deployment architecture. No owner database migration/restart or production push/deployment.

## Unreleased - Floor / Supervisor / Attendant worksheet (2026-11-13)

- Extended the existing worksheet with single/bulk primary floor assignment, per-floor workload and visible room-specific exceptions. Supervisor replacement preserves active attendant work and local progress; undo restores responsibility safely.
- Added My Floors and My Attendants with automatic own-floor room scope, eligible registered unallocated attendants, atomic team/room autosave and backend cross-floor/team restrictions. Existing optimistic rollback, concurrency checks, audit and Fastify WebSocket reconciliation remain in use.
- Added Supervisor Master and Attendant print modes from the existing preview, per-floor/supervisor totals, unassigned rooms, attendant signatures, saved revision/time, snapshot provenance and STALE indicators. Browser print/Save PDF remains A4 portrait without an external service.
- Reused migrations 0004/0005 and existing assignment/history tables unchanged. OHIP floor values take priority over validated local fallback; no room-number inference, synthetic live rooms, duplicate user registry or Oracle mutation was introduced.
- Expanded disposable API/frontend/browser regressions for floor ownership, safe replacement, supervisor scope, registered staff, workload, undo, conflicts, both print modes, mobile and realtime. No production push/deployment or owner database migration.

## Unreleased - Housekeeping Worksheet UX (2026-11-12)

- Replaced the daily multi-form rooms assignment UI with one drag/drop worksheet: unassigned lane, registered supervisor groups, attendants, multi-select assignment, filters, debounced local autosave, optimistic totals, rollback and undo.
- Added atomically transferred supervisor coverage/team/room moves over the existing assignment tables, property revisions, idempotent mutations, full audit/undo plans and scoped WebSocket invalidation. Staff availability defaults on first use only when no explicit unavailable schedule exists.
- Added strict, contract-reviewed GET room overview and existing task-sheet reads; forced generateCleaningSequence=false and preserved all Oracle mutation guards. Live feed failure/denial shows a clear empty state and never substitutes DEMO, manual Unknown rooms or invented credits.
- Added My Worksheet/My Team landing views, authorized mobile Assign To, browser-only A4 print preview/Save PDF and per-attendant page breaks.
- Added migration 0005 for room feed cache, worksheet change history, provenance/active-link metadata and date/shift event details; retained prior data, migrations, users, RBAC, old APIs, Fastify WebSocket and SPA deployment.
- Added API/feed/policy, concurrency, autosave/rollback, undo, native drag/drop, print/PDF and responsive browser regressions. Tests use disposable databases and synthetic OHIP contracts; no production push/deployment or live Oracle write.

## Unreleased - Local Housekeeping assignments (2026-11-12)

- Added Supervisor/Room Attendant directory metadata referencing registered users, active tenant memberships and property grants; no duplicate user identity table.
- Added migration 0004: property shifts, dated availability schedules, mixed supervisor floor/room coverage, attendant supervisor/floor/section/room assignments, retained room assignment history, and validated room mapping with workload credits.
- Added transactionally serialized, audited local APIs under `/api/local-housekeeping`, coverage checks, active-room uniqueness per date/shift, and server-side manager/authorized-supervisor/attendant/IT/admin permissions.
- Extended `/operations/rooms` with morning briefing, unassigned resources, workload imbalance warnings, and end-of-shift OPERA snapshot comparisons independent of explicit local progress. Preserved existing read-only snapshot cards for administrative/front-office roles.
- Added property/role scoped WebSocket invalidation, live permission revocation checks and Housekeeping refresh on room/reservation snapshot events.
- Preserved strict OHIP mutation guards, outbound operation allowlist, Fastify WebSocket, SPA, and OHIP Task Sheets. Existing adapter has no live OHIP room feed; cached room data is labeled accordingly.
- Added API, permission, isolation, credit aggregation, snapshot/progress, realtime and browser smoke regressions using disposable databases. No production migration, push, or deployment.

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
