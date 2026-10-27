# Changelog

## 1.0.0 — 2026-10-27

- Bootstrapped an empty repository into npm workspaces: Fastify/TypeScript, React/Vite, shared contracts, PostgreSQL via Drizzle.
- Added scoped operational dashboards, reservation search/detail, guest summaries, housekeeping, and task creation/assignment/acknowledgment.
- Added server-side multi-property summaries, comparison, and actionable alerts.
- Added cookie sessions, CSRF, role permissions, property grants, AES-GCM secret storage, safe error handling, and administrator audit trail.
- Added authenticated Fastify WebSocket notifications, persisted sequences, replay/reconciliation, reconnect backoff, focus refetch, and polling fallback.
- Added OCIM read-only adapter, official Oracle contract fixtures for tags 26.2 / 26.3 / v26.4, bounded safe retry, checkpoints, request telemetry, and dead-letter recovery.
- Added clearly labeled demo seed, embedded local demo option, Docker Compose, migrations, setup and deployment documentation, and automated tests.
- Oracle live credentials, streaming, production deployment, and device/browser visual validation remain separate acceptance gates; see README and validation report.
