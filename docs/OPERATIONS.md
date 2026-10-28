# Operational features and Oracle boundaries

V1 is now locked to **OHIP READ ONLY**. Operational task/housekeeping writes are absent from UI; legacy local DEMO APIs remain only for compatibility/internal fixture changes and never forward Oracle mutations. Oracle-mapped property writes are rejected. See [strict policy and approved endpoint inventory](OHIP_READ_ONLY_POLICY.md).

## Working features

- Morning briefing with source timestamps; arrivals, departures, VIP and in-house counts drill into filtered reservations. Search by confirmation/guest name, arrival and status; paginated reservation detail.
- Rooms requiring attention and local housekeeping inspection; priority task creation, assignment, acknowledgment and completion. Changes are stored, audited and delivered to other browsers.
- Server-side command center grouped by the current tenant and authorized properties, organization/date filters, property comparison and alerts. Property links select the corresponding operational workspace.
- OCIM shared/dedicated connections with property-specific Hotel IDs, encrypted credentials, request telemetry, correlation IDs, HTTP/latency/error classifications, safe read retries, bounded backoff and dead letters.
- Organizations, properties, users/roles/property grants, branding and audit trail. Editing access revokes existing sessions. Platform administrators can provision an empty tenant and switch only to tenants where they hold membership.
- Persistent React Router shell, lazy routes, skeleton/empty/error states, role-based menus, desktop/tablet/mobile layout, tenant app name/logo/favicon/color/title resolution.
- Native Fastify WebSockets: authenticated cookie + Origin + CSRF, fresh grant checks, scoped metadata without PII, heartbeat/ping, bounded buffers, sequence replay, reconnection, reconciliation, focus refetch and 30-second HTTP fallback.

## Oracle setup and limits

1. Create an **empty property** and grant the operator access. Demo and Oracle reservations cannot be mixed in a property; configuring the opposite source is rejected rather than deleting records.
2. Set `ENCRYPTION_KEY` to a cryptographically random 32-byte key encoded as 64 hex characters, stored outside source control. Retain it securely for decryption/rotation.
3. Set `OHIP_ALLOWED_HOSTS` to exact approved gateway hostnames. The adapter requires HTTPS, rejects URL credentials/extra paths/ports, and refuses redirects. TLS verification stays enabled.
4. In OHIP Connections, select a property and Create New Connection with only baseUrl, clientId, clientSecret, appKey, enterpriseId and hotelId. For shared credentials use Use Existing Connection and the new property Hotel ID. Credentials remain write-only; blank secret fields on Edit Connection preserve saved values. OAuth and a bounded read-only reservation search validate Hotel ID access before activation. There is no Chain Mapping requirement.
5. Authorize the documented read operation in Oracle and inspect Integration Health and Request Logs. No real Oracle credentials or hotel access were supplied for this implementation.

The adapter uses the official `POST /rsv/v1/hotels/{hotelId}/reservations/searches` operation, with OCIM `/oauth/v1/tokens`, token reuse and one 401 refresh. Read-only semantics make this POST search safe to retry; arbitrary POST/mutation retries are not supported. API permissions remain controlled by Oracle. SSD/resource-owner authentication is not implemented.

The worker polls at least every 30 seconds (default 60), sends real requests at a configurable minimum spacing (default 250 ms per process), honors throttling `Retry-After`, and uses database leases plus `SKIP LOCKED`. Each job is bounded to 20 pages/search, 100 records/page, 1,000 cached IDs and an eight-minute deadline; exceeding a limit becomes a visible failure instead of a successful partial sync. Attempts stop after five and enter dead letters; authorized manual retry is audited. Configure intervals for the customer's API entitlement; multiple replicas require a shared outbound quota limiter before production.

Polling covers current arrivals, departures and in-house reservations, then reconciles cached operational IDs to catch reschedules/cancellations. Changed snapshots are upserted atomically with the checkpoint and event outbox. Repeated identical snapshots preserve their timestamps; returning to an older state is still applied. Search is over the ingested local read model; this is not an unlimited Oracle search/archive. Missing/deleted reservations require an agreed upstream reconciliation policy; absence is not interpreted as deletion.

Oracle Business Events/Streaming is **not enabled or claimed**. Enable a separately validated ingestion adapter only after the property's capability, permissions and consumer restrictions are known. Guest Profiles currently shows reservation guest summaries, not a full CRM profile feed. Room states/tasks are local operational data; Oracle room/profile writes and imports are not implemented. Date filters use reservation stay dates in the current read model; there are no historical KPI snapshots, and tasks/connection status reflect current state.

Contracts and synthetic mapping fixtures are validated against official Oracle tags **26.2**, **26.3**, and **v26.4**. The RSV specification bundled in v26.4 still declares version 26.3.0.0. This confirms fixture compatibility, not live hotel compatibility or production readiness. Sources and license are recorded in [fixtures/README.md](fixtures/README.md).

