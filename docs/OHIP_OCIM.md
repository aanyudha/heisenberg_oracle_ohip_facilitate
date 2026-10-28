# OHIP OCIM connections

## Six-parameter form

The connection form has exactly `baseUrl`, `clientId`, `clientSecret`, `appKey`, `enterpriseId`, `hotelId`. The selected property is authorization/routing context from the existing workspace selector, not another credential input. No Chain ID, Chain Mapping, scope, environment or deployment-mode field is required.

`baseUrl` is an exact allowlisted HTTPS OHIP gateway origin. Credentials use OCIM Client Credentials at `/oauth/v1/tokens` with Basic client authentication, `enterpriseId`, `x-app-key`, and the backend constant scope `urn:opc:hgbu:ws:__myscopes__`. Operational requests use `Authorization: Bearer ...`, `x-app-key`, and `x-hotelid` from the selected property's persisted mapping. Token renewal issues another client-credentials request; it does not invent a refresh-token flow. See [Oracle property headers and scope](https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/c_calling_oracle_hospitality_property_apis_ocim.htm) and [Oracle OCIM migration guidance](https://docs.oracle.com/en/industries/hospitality/integration-platform/ohipu/t_migrating_to_client_credentials_based_authentication_scheme_ocim.htm).

## Property workflows

- Create New Connection: select the property in the workspace, enter the six values, then Validate and Create. OAuth and a bounded reservation search for that Hotel ID must succeed before credentials/assignment are committed.
- Use Existing Connection: choose an accessible connection within the same tenant and supply the target property's Hotel ID. No credentials are requested or returned. Validation failure leaves the previous assignment intact.
- Create Dedicated Connection: create a connection with different credentials for the selected property. Identical credentials are reused within the tenant instead of duplicated.
- Edit Connection: select a property already assigned to the connection. Empty client-secret/app-key fields preserve saved ciphertext. Credential changes validate every assigned Hotel ID before an atomic update. Editing shared credentials requires grants for every affected property; otherwise create a dedicated connection.
- Test Connection: validates the stored mapping. A successful test enables a pending mapping; a failed test marks that property invalid and stops it from being polled until validation succeeds.

Connection List exposes only safe metadata and authorized assigned-property rows, plus health, last connected, and validation state. Stored secrets and ciphertext are never returned, including after save/edit. Each assignment/configuration/test action is audited with tenant, property, actor and connection ID. Telemetry stores operation/status/latency/correlation/classification only.

A property's demo and Oracle reservations cannot be mixed. Use an empty property when activating Oracle. Existing demo adapters, operational dashboards, authorization and realtime remain available.

## Connection API

All routes require the existing authenticated session and Integrations role; writes also require CSRF. `propertyId` is the selected authorized property, never a caller-supplied tenant override.

| Method and route | Purpose |
| --- | --- |
| GET /api/ohip-connections | Safe connection metadata and authorized assigned properties; page/limit supported |
| POST /api/ohip-connections | Six parameters plus selected property context; validate, deduplicate within tenant and assign |
| PATCH /api/ohip-connections/:id | Edit the six parameters for the selected assignment; omitted/empty secrets preserve saved values |
| POST /api/ohip-connections/:id/assign | Use existing connection with propertyId and hotelId only |
| POST /api/ohip-connections/:id/test | Test stored mapping using propertyId only |

OpenAPI at `/docs` documents the request schemas and write-only secret fields. The old GET /api/connections remains a sanitized per-property operational-state read for existing health screens. Its legacy PUT only supports the demo adapter; live credential writes use the normalized OCIM routes.

## Persistence and migration

`ohip_connections` contains the requested tenant-scoped gateway/client ID/encrypted client secret/encrypted app key/Enterprise ID/status/timestamps. `ohip_connection_properties` contains tenant/connection/property/Hotel ID, primary marker, validation status and last-validated timestamp. Composite foreign keys prevent cross-tenant assignments, one assignment is allowed per property, and at most one assignment is primary per connection. The backend selects primary automatically; it is not a required form field.

The existing `connections` table remains as the per-property worker schedule/checkpoint/status and historical-chain record. Live operational reads join the normalized credential and property tables; old gateway/Hotel ID/chain columns do not control routing. New saves do not duplicate credentials into this legacy table.

Migration 0002 runs under the existing advisory migration lock and transaction before the HTTP listener starts:

1. Create both normalized tables and constraints.
2. Decrypt each real legacy credential bundle using the original ENCRYPTION_KEY.
3. Reuse an identical credential row only within the same tenant, otherwise encrypt the client secret and app key into separate fields.
4. Copy each original property and Hotel ID assignment. Preserve historical chain and environment fields.
5. After normalized credentials and assignment exist, clear that row's old encrypted bundle in the same transaction. No duplicate live credential copy remains.
6. Record migration 0002 only after all rows succeed. Wrong/missing keys or any database error roll back the tables/backfill/version together, leaving the original credentials available for recovery.

Legacy assignments with a prior successful `last_sync` are marked validated using that evidence. Assignments without a successful sync remain pending; an authorized user must run Test Connection. No live Oracle request is made by the migration itself.

Before upgrading, stop the app, take a consistent embedded-directory backup or PostgreSQL backup, and retain the original ENCRYPTION_KEY. Back up both database and key securely. Do not downgrade to an executable that only understands the legacy credential blob: a full rollback requires the pre-migration database backup and original application/key. Restart/recreate persistence follows the deployment guide.

## Worker and cache

Every poll resolves tenant, authorized stored property assignment, connection and Hotel ID from the database. Only validated live mappings are scheduled. Tokens are shared across Hotel IDs within the same tenant/connection/credential revision, with an in-memory bounded cache and a single concurrent refresh. Expiry refresh happens before token expiration and one HTTP 401 triggers one re-authentication; a repeated 401 fails without a GET fallback.

Changing credentials or Hotel ID invalidates that property's cached adapter route. Before applying a poll response, the worker verifies that the connection revision and Hotel ID still match; stale results from an old assignment are discarded. Poll jobs remain property-scoped and use the existing bounded retry/outbox/audit flow.

## Validation boundaries

Automated tests exercise the real HTTP adapter with fake Oracle responses for OAuth, headers, refresh, Hotel ID denial and property access checks. They cover encrypted credential preservation, shared/dedicated connections, tenant/property/role isolation, concurrent deduplication, stale polling results, gateway rejection, six-input React forms and safe migration rollback. The deployment matrix additionally runs the regression suite on real PostgreSQL using temporary schemas, and checks the built UI in native embedded, native PostgreSQL and Docker modes.

No customer OCIM credentials were supplied for a live acceptance test. Local/fake Oracle success does not establish actual customer API subscription, Hotel ID access, gateway TLS trust or OPERA availability. Production deployment and remote push are not part of this change.
