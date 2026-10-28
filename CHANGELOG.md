# Changelog

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
