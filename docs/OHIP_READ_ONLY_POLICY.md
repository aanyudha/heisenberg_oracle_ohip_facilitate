# Strict OHIP read-only policy - V1

V1 views and monitors OPERA snapshots. It cannot create, update, cancel or delete Oracle business data. Read-only is enforced by executable backend policy rather than by the absence of frontend buttons alone. No customer credentials are changed by this lock, and no database migration is added.

## Configuration and trust boundary

Root `.env` supports only `OHIP_ACCESS_MODE=read_only` and `OHIP_MUTATIONS_ENABLED=false`. Missing variables use those defaults. Empty/unknown/write/admin modes or `true` are invalid; there is no supported switch to enable mutations. `applyConfig` applies validated values to the server. The HTTP policy independently refuses an unsafe runtime value; request parameters cannot select a different policy.

All production outbound OHIP HTTP calls go through `OhipHttpClient` in `apps/api/src/ohip-policy.ts`. `RealOhipAdapter` builds fixed operations, never browser-selected method/path/body. The gateway guard is reused from `ohip-gateway.ts`; exact HTTPS hostname allowlisting, no credentials/path/port overrides, IP/local-host rejection, and redirect rejection remain enforced.

Before dispatch, policy checks:

- An exact allowlisted operation identity, method and path, including Hotel ID/path/header consistency.
- Strict operation-specific body/query semantics and an explicit header allowlist; method-override headers and unknown body/query fields are denied.
- Matching tenant, authorized property, assigned connection and Hotel ID, plus the assigned gateway origin.
- A fresh server authorization callback. Connection tests re-check the active session, membership role and property grant. Polling re-checks persisted tenant/property mapping, validation state and credential revision. Authorization is checked again immediately before transport and before returning a cached response.

A missing/false authorization proof fails closed. Mock transports in tests carry explicit synthetic scope; production callers always supply database-backed scope. Default fetch cannot dispatch without an audit callback. Audit rows contain operation/status/classification/latency/correlation and tenant/property identifiers, never headers, secret values, bodies, guest names or reservation identifiers. A denied arbitrary operation is logged as `blocked_operation`, not attacker-supplied text.

## Complete allowed outbound inventory

| Policy operation | Method and exact endpoint | Permitted semantics | V1 use |
| --- | --- | --- | --- |
| `oauth_token` | POST `/oauth/v1/tokens` | Exactly `grant_type=client_credentials`, backend scope `urn:opc:hgbu:ws:__myscopes__`, Basic client auth, application key and matching enterpriseId | OCIM token acquisition/renewal; local audit alias for Oracle's officially named OAuth request |
| `searchHotelReservations` | POST `/rsv/v1/hotels/{assignedHotelId}/reservations/searches` | Strict bounded search only; see below | Polling and connection/property validation |
| `getReservation` | GET `/rsv/v1/hotels/{assignedHotelId}/reservations/{reservationId}?markAsRecentlyAccessed=false&includeInSession=false` | Both false flags mandatory; no body, other query parameter or unknown header | Approved at the policy boundary and covered by mock tests; no new live business endpoint/controller added. Existing UI details continue to read the local cache. |

The business operation IDs/methods/path templates are checked against retained official Oracle RSV specs for release tags 26.2, 26.3 and v26.4. The v26.4 RSV document identifies its schema as 26.3.0.0; this is not a claim of a separate 26.4 schema. [Official Oracle RSV specification](https://github.com/oracle/hospitality-api-docs/blob/main/rest-api-specs/property/v1/rsv.json).

Search accepts only `searchType`, `limit` (1-100), `offset` (0-1900), and the applicable documented date/ID filter fields. Arrival/Departure are restricted to a single date. InHouse has no write/date/ID extras. Any is allowed for up to 100 cached reservation IDs; an unfiltered Any is restricted to limit 1/offset 0 for access testing. Unknown fields, GraphQL bodies, update/cancellation fields, path/query overrides and method-override headers are rejected.

**Classification limits:** Oracle documents `getReservation.markAsRecentlyAccessed` as marking a reservation recently accessed; it must never be true or left implicit here. The implementation also forces includeInSession=false, and denies other GET variants rather than assuming their defaults. The official OCIM example names the OAuth request but the retained RSV fixtures do not publish an OAuth machine operationId; `oauth_token` is explicitly a local alias, not a fabricated Oracle operationId. Its authentication-only endpoint/body/header semantics are independently pinned. [Official Oracle OCIM request](https://www.postman.com/hospitalityapis/oracle-hospitality-apis/request/yvi8whu/get-oauth-token-for-client-credentials-environments).

No other outbound operation is approved. Profile lookup, room/housekeeping lookup, availability and reports need their own authoritative contract/semantics audit before approval; this task does not add modules or assume those APIs are safe. Current guest summaries and room views are existing local snapshots, not a claim that a live CRM/housekeeping feed is connected.

## Blocked operations and direct API requests

Every operation outside the inventory is denied, including deceptive GETs and all unverified POST searches. Specifically denied categories include reservation creation/update/cancellation, check-in/out, room assignment/move/status updates, profile creation/update/delete, charges/payments, rate/inventory changes, housekeeping writes, event subscriptions and every GraphQL request (including mutation).

The backend returns HTTP 403 with `{ "error": "OHIP_READ_ONLY_POLICY" }` for direct Oracle/proxy namespaces such as `/api/ohip/*`, `/api/ohip-proxy`, `/api/oracle/*`, `/api/proxy/*`, `/api/graphql`, `/api/rsv/*`, `/api/crm/*`, `/api/hsk/*`, `/api/fof/*`, `/api/htl/*`, and blocked explorer namespaces. These are denial handlers, not forwarding endpoints. Reservation/profile/housekeeping/rate/inventory/availability/payment/charge/report API write requests are also rejected. Other unknown application routes remain non-existent (404); none forwards arbitrary Oracle requests.

Existing cached read endpoints (`GET /api/overview`, `/api/reservations`, `/api/reservations/:id`, `/api/rooms`, and monitoring reads) retain session, tenant/property and guest-role checks. `GET /api/ohip-policy` exposes only the immutable approved registry to authorized integration users. Local `/api/ohip-connections` configuration/assignment/test routes remain allowed and can only dispatch the approved authentication/access checks.

Operational task/room forms, assignment/status selectors, room-state buttons and related-task creation are absent from UI. Legacy local task/room write APIs are denied on Oracle-mapped properties. They remain local-only on non-Oracle/demo properties for compatibility and synthetic realtime/persistence tests; they have no Oracle write code path. This exception cannot enable an Oracle operation, regardless of payload or role. Local administrative identity/branding/connection writes are internal configuration, not PMS commands.

## UI, realtime and cache

The shell always displays **OHIP READ ONLY**. In-house guests uses the existing reservation filter. Connection administrators can still create/edit encrypted credentials, assign properties and validate access. Swagger describes local application APIs; its Try It Out submission methods are limited to GET. There is no raw OHIP API explorer/proxy.

Controlled polling remains colocated with Fastify, with the existing database leases, one-active-poll constraint, idempotent snapshot/event writes, rate limit and bounded retry. Only safe reservation reads are retryable; policy/permission failures are not retried as mutations. OAuth renewal uses client_credentials and one 401 re-authentication.

The HTTP client adds per-tenant/property/connection/Hotel ID/credential-revision response caching (up to 5 seconds, at most 100 successful responses per transport, entries above 2 MiB not cached) and identical in-flight request deduplication. OAuth and explicit connection health checks are not response-cached. Cache hits still require current authorization. The database remains the persistent read snapshot. Existing checks discard poll results when an assignment changes during the request.

WebSocket payloads remain scoped topic/sequence/property markers without guest PII. Workspace heartbeat/events do not prove Oracle synchronization. Dashboard source freshness uses the property's actual successful poll timestamp and connection status: demo, not_synced, synced, or stale. A failed connection or a snapshot older than max(3 minutes, three poll intervals) is stale. No LIVE label is inferred from the socket being connected. No streaming subscription is automatically created.

## Verification and operational limits

All original 95 regression cases remain, with synthetic authorization context added to direct adapter fixtures. New tests cover allowed GET with side-effect flags false, bounded POST search, OAuth, unknown/mutating operations, state-affecting GET options, proxy and GraphQL denial, method override/body injection, runtime config bypass attempts, tenant/property/connection/gateway mismatch, authorization revocation, caching/deduplication, default worker dispatch, stale snapshots and absent write controls. Tests assert zero transport calls for denied requests.

Use `npm run lint`, `npm run build`, `npm test`, `npm run test:browser`, and `npm run test:deployment`. Deployment tests use only isolated demo databases and mock Oracle responses; browser realtime changes are simulated through the legacy local DEMO fixture APIs. They do not create dummy reservations, mutate Oracle or contact a customer gateway. Native, PostgreSQL and Docker use the same compiled Fastify + React + WebSocket port. Test resources are uniquely named and cleaned; root .env is restored after smoke tests.

No customer OPERA production endpoint is used for mutation testing. A local/mock PASS is not live Oracle acceptance, API-subscription validation or production readiness. After replacing an already-running build, restart the application to load the policy; no production deployment or remote push is performed by this task.
