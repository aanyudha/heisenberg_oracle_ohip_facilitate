# Local actions and OHIP connection control

Audit of the existing implementation found a centralized Oracle read-only allowlist, cached reservation details, local create/access administration, and an OCIM connection manager. Missing controls were persistent pause/archive, scheduler/worker pause enforcement, local archive/update actions, and accessible row navigation. No additional Oracle operation is approved by this change.

## Data boundaries

- Reservations, arrivals, departures, in-house and guest summaries use clickable table rows (mouse, Enter, Space) and read-only native dialogs. Room cards open read-only cached details. Guest summaries remain reservation-derived; there is no new profile/housekeeping Oracle feed.
- Local tenant/organization/property records support create, edit and archive. Tenant edits/archives require platform administrator access in the current tenant. Switch workspaces to manage another tenant.
- User create/access edit/archive operates on the current tenant membership. Archive retains identity, membership, grants and historical references, revokes tenant sessions, and blocks subsequent login/switch into that membership. Self-archive/access changes are rejected; another administrator must manage them. The last active administrator is protected under the tenant transaction lock.
- Branding supports read/save/reset to defaults. These actions never call OHIP. Every successful management mutation writes an audit event in the same transaction.
- `DELETE /api/admin/{kind}/{id}` archives; it never deletes business/audit history. `PATCH` edits local names and property organization/timezone. Existing user access editing remains `PATCH /api/admin/users/{id}`. `DELETE /api/branding` resets the local configuration.

Archive of an organization/tenant requires its active child records to be archived first. Property archive rejects existing connection/mapping, other users' grants, active retry jobs and unfinished tasks. The actor's own grant is retained as history and excluded from effective access after archive. Remove/reassign dependencies first; no cascade or force-delete endpoint is provided. Archived records remain in the database; audit rows are never removed.

## Connection lifecycle

`POST /api/ohip-connections/{id}/control` accepts `action: pause | resume | archive`, plus either `propertyId` or `confirmGlobal: true`. Only administrators may control lifecycle. Global actions require access to every assignment. The UI displays the affected count/names before global confirmation. View/edit/test retain existing integration RBAC; test is disabled while paused and is still read-only.

Pause is persisted independently on the shared connection and on each assignment. Global resume preserves individual property pauses. Property resume cannot override global pause. Archive pauses the whole connection and retains credentials/mappings; it is omitted from active connection lists. Credential values are never cleared, revoked or automatically rotated.

The centralized outbound client executes its final transport through a database transaction holding the same tenant advisory lock as pause/archive. Pause waits for already-dispatched response headers (existing HTTP timeouts apply). Later requests, including OAuth and retries, are rejected before transport. Bodies already arriving may finish reading, but worker results are discarded when the connection revision, assignment revision or pause state changed. A property pause/resume cycle also invalidates an earlier worker snapshot.

Scheduler enqueue rechecks pause under that lock. Worker claims exclude paused assignments/connections. Already queued jobs are retained without dispatch; manual retry is rejected while paused. Resume validates administrator permission, allowed HTTPS gateway, decryptable configuration and validated assignments, then makes polling due. The existing bounded worker performs reservation reconciliation; there is no synchronous full import or page reload. It does not assert successful live connectivity until a poll succeeds.

Pause survives process/database reopen. A connection in `PAUSED` cannot be shown as live even if a previous test/poll wrote a healthy legacy status. Browser WebSocket connectivity, OHIP lifecycle and property snapshot freshness are displayed separately. Cached Oracle data remains readable with `Stale` while paused; resume shows `Syncing` until polling completes. Demo snapshots remain explicitly labeled `DEMO`.

Connection edits retain their existing pre-save read-only validation, so resume a paused connection/assignment before editing or testing it. Resume checks saved configuration locally and makes reconciliation due; it does not claim that Oracle has already responded successfully.

Transient identity refetch failures retain the cached workspace and selected property during server restart. A 401 still switches to login. This preserves SPA state while WebSocket reconnects, without treating a transport outage as session revocation.

## Migration and validation

Migration `0003_local_controls.sql` adds shared pause/archive, assignment pause/revision, and a tenant-scoped local archive registry. It changes no credential values and preserves existing table row shapes for historical records.

Run `npm run lint`, `npm run build`, `npm test`, and `npm run test:deployment`. The deployment harness uses isolated test databases/Compose projects and restores the original root `.env` in `finally`. Native browser and Docker smoke validate SPA/API/WebSocket/restart behavior; mock OHIP regressions and database locking tests do not constitute live OPERA validation. No production deployment is performed.
