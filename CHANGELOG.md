# Changelog

## Unreleased — single-server deployment

- Native deployment now uses `npm install`, `npm run build`, `npm start`; backend JavaScript, React assets and migrations are emitted into `dist/` and served by one Fastify on configurable port 3000.
- Added zero-configuration persistent embedded demo startup, first-run-only sample initialization, transactional migration locking, and validated production settings with no production seeding.
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
