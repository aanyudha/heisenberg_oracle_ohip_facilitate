# Housekeeping Worksheet

Daily workflow: **OPERA data → drag & drop → Print Worksheet / My Worksheet**.

`/operations/rooms` is one worksheet. Property and business date use the existing workspace controls; shift, actual room-feed sync time, save state and Print Worksheet appear in the worksheet header. Front-office users retain their existing read-only room view. Administrative configuration is separate at `/operations/rooms-settings` and is not part of daily assignment.

## Audit of the previous implementation

The original screen combined staff role setup, shifts, room mapping, availability, supervisor coverage, attendant selectors, morning briefing and end-of-shift tables. Managers had to release rooms, change coverage, then allocate rooms again. Its local directory left join also exposed manually mapped rooms as Unknown when no room snapshot existed. The existing OHIP adapter polled reservations and had no room feed.

The redesign retains users, memberships, property grants, Housekeeping job metadata, migrations 0001–0004, schedules, supervisor/attendant/room assignments, audit history, old APIs, Fastify WebSocket and the SPA deployment. It adds an atomic worksheet API over the same assignment tables. The primary screen no longer uses the legacy Unknown-room board or requires daily coverage/availability forms. Legacy administrative screens/APIs remain for compatibility; their Unknown mapping entries are not a live room source for the worksheet.

## Authorized OPERA room data

Only these named Housekeeping reads are added to the default-deny outbound policy:

| Operation | Exact path and fixed query |
| --- | --- |
| `getHousekeepingOverview` | GET `/hsk/v1/hotels/{assignedHotelId}/housekeepingOverview?limit=100&offset={boundedOffset}&fetchInstructions=ResvInfo` |
| `getHouseKeepingTasks` | GET `/hsk/v1/hotels/{assignedHotelId}/houseKeepingtasks?taskDate={date}&generateCleaningSequence=false&includeReservationInfo=false&includeTaskSheetDetails=true&includeTaskSheetsSummary=true` |

The operation names, parameters and response paths were reviewed against Oracle's [HSK 26.3 specification](https://github.com/oracle/hospitality-api-docs/blob/26.3/rest-api-specs/property/v1/hsk.json). The actual existing-task-sheet GET is named `getHouseKeepingTasks`; no guessed GET `/taskSheets` endpoint is used. Oracle documents `generateCleaningSequence=true` as generating a sequence, so the policy requires **false**, including on retries. Missing/true flags, arbitrary queries, status-change parameters, method overrides and all business POST/PUT/PATCH/DELETE variants are rejected before transport. `getTaskCompanion` is not added to the allowlist.

OCIM still acquires tokens using its existing authentication-only POST. Existing bounded read-only reservation search polling is preserved independently; the worksheet never dispatches a business POST or calls that search to load rooms. It enriches rooms using permitted reservation fields from the overview and the existing authorized local reservation cache. Cached DEMO reservations are excluded from live enrichment.

The worksheet automatically reads the room feed on load. A property/date cache lasts 30 seconds, concurrent reads share one in-flight request, and the existing query polling/WebSocket reconciliation keeps active views current. No Oracle background create/update, task-sheet generation, assignment write, room-status write or subscription is introduced.

The overview is paginated with a requested page size of 100, advancing by the actual raw room count so a smaller server page does not skip rooms. Reads are bounded to 100 pages, offsets 0–9900 and a two-minute deadline plus the bounded request timeout. Empty/inconsistent pagination, duplicate room IDs, contract failures and unapproved/mismatched Hotel IDs fail closed instead of publishing a partial room list. Pseudo rooms are excluded. Floor, room type, room sections, statuses and reservation flags come from actual response fields; floor is never derived from the room number.

Task sheets are optional enrichment. A permission, availability or contract failure there leaves the authorized overview usable and shows a clear warning. Existing per-room task credits take precedence; credits across distinct returned sheets are totaled with their task descriptions. Repeated sheet/room records or incomplete declared sheet counts are rejected for enrichment. Oracle attendant IDs are not imported as application users or used as local assignees.

The mapper persists only room identifiers/location/type/status, housekeeping flags, permitted room task instructions and credit totals. Guest names, profile/reservation identifiers, contact details, payment data and arbitrary raw Oracle payloads are discarded. Registered staff names are returned only inside the authorized property/team scope.

### Live empty/error states

Live mode requires a validated, active connection/property binding. Missing authorization, paused/archived connections, denied Housekeeping access, malformed feeds and empty overview results display an explicit error/empty state. The worksheet does not fall back to DEMO, arbitrary old `rooms` rows, manual mapping-only rooms or synthesized Unknown rooms. Existing assignments remain stored and a count identifies assigned rooms absent from the current feed. Printing/room allocation is unavailable without usable room data.

DEMO uses actual seeded snapshot rows and is visibly labeled **DEMO — no Oracle sync**. A mapping with no corresponding snapshot is excluded even in DEMO. Missing floor/type/credits remain explicitly unavailable; no room record or status is invented to fill them.

Overview statuses describe OPERA **now**, not a reconstructed historical snapshot. The selected date scopes local assignments and task sheets; current status observation time remains visible. Live reservation metadata may be incomplete or stale. The feature does not claim production OHIP compatibility until the property's real credentials/entitlements and response contract are accepted.

## Assignment on one screen

- The left lane contains Unassigned Rooms. The right side has registered supervisor groups and their attendants. A compact available-attendant roster sits beside the groups.
- Drag an attendant into a supervisor group, then drag a room into that attendant. Room moves between attendants and attendant moves between supervisors are atomic, including coverage transfer.
- Select multiple room checkboxes (or all filtered rooms), choose an attendant and use **Assign selected**. One batch move covers the selection.
- Filter by actual/validated floor, OPERA status/Departure/Stayover/Arrival/VIP/DND/Priority, and available room type. Filters never change assignments or restrict the printed report.
- A simple **Assign To** selector provides keyboard/mobile reassignment for authorized managers/supervisors. There is no Save button per room.
- Undo cancels the last pending move locally, or restores the last persisted move using the undo API. When multiple actions share a debounce batch, undo restores only the final action, not the whole batch. Another user's/configuration edit invalidates undo rather than overwriting their work.

Staff come from existing `users`, active tenant memberships and property grants, with the existing Housekeeping department/job metadata. There is no second user registry. An explicitly unavailable schedule blocks new assignments. Otherwise, a valid registered staff member may start a worksheet immediately; the first write creates that date/shift's Available schedule and resolves coverage locally. An existing shift and one-time property staff-role configuration are still required. Those administrative controls are separate from the daily worksheet.

New feed rooms do not require manual room/floor entry. If assigning one needs a legacy directory entry, the backend materializes the verified feed location with `location_source=OHIP`; it does not create an Oracle room or a fake OPERA snapshot row. Missing location remains unavailable. Existing validated local directory overrides and per-room credit configuration are preserved. The configuration page remains the place for deliberate validated location/credit changes, subject to existing coverage safeguards.

## Autosave, conflicts and history

Moves update the UI and all room/credit/departure/stayover/priority/supervisor totals immediately. Saves debounce for 500 ms and are serialized; further moves wait in the next batch. The UI shows pending/saving/saved state. A failed or conflicting save discards pending optimistic moves, restores confirmed state, refreshes the server worksheet and displays the error. Printing and shift changes wait until saves settle. Leaving the page flushes queued local intent; closing/reloading with pending work raises the browser's unsaved-work warning.

Each save requires the current `baseRevision` and a UUID `mutationId`. Tenant advisory locking coordinates with existing membership/archive edits; property locking serializes assignment transactions. The revision is the latest property Housekeeping change-event sequence, so edits to another date/shift or staff configuration can conservatively cause a conflict. They never mix assignment data across scopes. Stale requests return HTTP 409 and cannot silently overwrite a newer plan. Repeating the identical mutation ID/body/actor is idempotent; reusing it for another body/actor is rejected.

All selected room moves, automatic coverage transfers, team changes, schedules, audit records and event insertion commit together. The existing partial unique index still prevents two active room assignments in one tenant/property/business-date/shift. There is no intermediate source-release step in the daily UI.

Worksheet history records actor, scope, mutation hash, base/result revisions and before/after plans, with a separate undo target for the final action. Room baselines and explicit local progress are preserved on moves. Undo never deletes historical room records; an inactive team-link flag retains foreign-key history for links created by a subsequently undone move.

Property/role-scoped WebSocket events contain no room/guest payload. Assignment events include only kind/date/shift metadata so the browser invalidates the affected worksheet rather than every dashboard/setup query. Room/reservation/integration events refresh room/workload data. Sessions, current grants and archived accounts are rechecked for established sockets. API access and current connection/snapshot binding are checked again after asynchronous reads and before save.

## Workload and status

Each attendant and supervisor shows total assigned rooms, known credits, departure, stayover, priority and local outstanding rooms. The unassigned count changes immediately with each move. A workload warning identifies an attendant exceeding 150% of the available team's average, including available staff with no rooms.

Credits are labeled **OHIP**, **Local rule**, or **Credits unconfigured**. If task-sheet credits are absent, only existing explicit local per-room configuration is used. Missing credits remain null, are flagged in totals and are never silently assumed to be zero or a fabricated default. Totals show the sum of known credits; this is an operational plan, not payroll or an immutable historical credit ledger.

Priority highlights actual OPERA cleaning/task priority, VIP, departure or Make Up Room. Dirty/Clean/Inspected, DND, OOO/OOS and arrival/stayover/departure are separate flags. OPERA status remains read-only. Local outstanding means an active local assignment whose explicit progress is not completed; a status/snapshot change never infers completion. The existing authorized local progress API remains available independently of OPERA status.

## Mobile and print

Configured attendants landing at `/` go directly to **My Worksheet** and see only their own rooms, OPERA status, priority, allowed task notes and credits. Configured supervisors land at **My Team**, with their own attendants, rooms, credits and outstanding work. Neither needs a setup form. Authorized supervisors/managers may use the simple Assign To selector on mobile; attendants have no reassignment controls. Incoming assignments reconcile through the existing WebSocket connection.

**Print Worksheet** opens an in-browser preview for the whole authorized worksheet, independent of screen filters. It includes hotel/date/shift, supervisor, attendant, floors/rooms, OPERA status, task, credit provenance, remarks, local progress and totals for both attendant and supervisor. Managers also receive an unassigned-room report. Page breaks start a new attendant; long room lists can continue to another A4 portrait page with repeating table headers. Print CSS uses wrapping cells, fixed column proportions and no clipped scroll containers. Print / Save PDF calls `window.print()`; there is no external PDF service or guest-data export.

## API and schema

| Route | Method | Contract |
| --- | --- | --- |
| `/api/local-housekeeping/worksheet` | GET | `propertyId,date,shiftId`; role-filtered data, roster, revision and feed state |
| `/api/local-housekeeping/worksheet` | PUT | Scope + `baseRevision,mutationId,operations` |
| `/api/local-housekeeping/worksheet/undo` | POST | Scope + `baseRevision,mutationId,changeId`; own last unchanged move only |

Operations are `{type:"rooms",roomIds:[...],attendantId:string|null}` or `{type:"team",attendantId,supervisorId}`. Null releases rooms locally. Manager/administrative RBAC can regroup attendants and transfer coverage. Authorized supervisors can change rooms only within their existing team/coverage; they cannot take another supervisor's attendant or room. Room attendants are read-only. Every route derives tenant from the session; client tenant overrides are rejected. Writes retain session, CSRF, origin and rate-limit protection.

The earlier `/setup`, `/staff`, `/shifts`, `/directory`, `/schedules`, `/supervisors`, `/attendants`, `/progress/:id` and `/board` APIs remain, with their existing RBAC and semantics. They are not Oracle forwarding endpoints. Direct Oracle/proxy namespaces and `/api/housekeeping` mutation guards remain blocked.

Migration `0005_housekeeping_worksheet.sql` appends room-feed caching and worksheet-change history tables, directory provenance/configuration flags, an inactive team-link flag and lightweight change-event metadata. It preserves prior data and migrations, users, staff profiles, assignment tables, uniqueness and history. No existing owner database is migrated by the test workflow.

## Verification

Run sequentially using disposable databases:

```sh
npm.cmd run lint
npm.cmd run build
npm.cmd test
npm.cmd run test:housekeeping-smoke
```

The browser smoke serves compiled React assets through an isolated source Fastify app, uses random loopback ports and disposable PGlite, and tests real native drag/drop, batch moves, autosave/rollback, manager conflicts, undo, source updates, mobile own/team visibility, WebSocket reassignment, filters, preview and real A4 PDF output. It uses separate browser actors while retaining the application's existing per-IP rate limit. It does not edit `.env`, use owner databases, restart owner processes or deploy production. The unchanged deployment scripts that temporarily edit `.env` are not used by this smoke.

Artifacts: `artifacts/housekeeping-desktop.png`, `housekeeping-mobile.png`, `housekeeping-attendant-mobile.png`, `housekeeping-print-preview.png`, `housekeeping-worksheet.pdf` and `housekeeping-smoke.json`.

The HSK source contract and permission/error paths are tested with synthetic transport responses. Live Oracle entitlement, live property pagination/task-credit behavior, external PostgreSQL and Docker remain separate acceptance checks; successful local tests are not production evidence. No push or production deployment is performed.

### Local acceptance — 2026-11-12

| Check | Result |
| --- | --- |
| ESLint | PASS |
| TypeScript / React production build / Fastify bundle | PASS |
| Existing and new tests | PASS — 189 tests in 14 files |
| Isolated Chrome/Playwright worksheet smoke | PASS — 26 checks, zero browser page errors |
| Desktop 1440×1000 / mobile 390×844 | PASS — manager and attendant layouts have no page-level horizontal overflow |
| Native drag/drop, batch moves, debounce, rollback, undo, user conflicts | PASS |
| My Worksheet / My Team and scoped WebSocket reassignment | PASS |
| Print preview, unclipped tables and actual A4 portrait PDF with attendant page breaks | PASS |
| OPERA contract mapping, smaller server pagination, safe GET policy and no synthetic live fallback | PASS with synthetic authorized transport |
| Live OPERA entitlement / real hotel responses | NOT TESTED |
| External PostgreSQL / Docker acceptance for this change | NOT TESTED |
| Owner DB migration, owner runtime restart, push or production deployment | NOT PERFORMED |
