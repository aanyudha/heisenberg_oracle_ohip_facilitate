# Housekeeping simplification and English restoration

## What caused the complexity

The previous change translated operational labels and routed routine assignment through a separate roster editor containing advanced shift settings. It also hid or disabled otherwise eligible registered staff until those setup steps were completed. Repeated per-room dropdowns competed with bulk selection. These choices made ordinary floor and room allocation harder to discover.

The daily worksheet now uses English and the existing design language. It has Business Date and Shift, Floor Assignment, rooms/filters, registered Room Attendants, saved counts and Print Worksheet. Role, active/archive status and property membership still come exclusively from User Management.

## Current behavior

- Scheduled Supervisor: choose the floor and Supervisor; save immediately without another confirmation. Multiple selected floors save once.
- Eligible Not Scheduled Supervisor: the inline action names the staff member, date/shift and floors. **Add to Shift & Assign** explicitly schedules and assigns atomically.
- Eligible registered Room Attendants remain visible, scheduled first. Managers can Add to Shift directly, or schedule and assign in one explicit action. Inactive/unauthorized users cannot be scheduled or assigned.
- Supervisor: open My Floors, select rooms, choose a Room Attendant and assign. Multi-attendant distribution retains Equal Rooms/Balanced Credits, preview and one confirmation. Single-room assignments use the same toolbar; drag/drop remains.
- Advanced shift settings stay outside the main worksheet. No role settings, setup wizard or mandatory roster panel precedes assignment. No default-all-presence behavior is used.
- Saved assignments and print reconciliation retain their existing scope and validation. Missing credits show a dash without blocking allocation. Genuine failures remain visible.

## Atomicity and safety

The existing local worksheet command now accepts a bounded, explicit schedule operation. Only an existing authorized Manager can use it for active registered Supervisor/Attendant identities with the correct tenant/property/role. Active shift validation and expected revision checks precede scheduling. Scheduling and floor/team/room writes share the existing lock and transaction: any failure rolls back both. Idempotent retries do not reschedule/reassign twice.

Combined Undo restores assignment and previous shift availability. Existing audit/history JSON stores attendance before/after; new rows become unavailable on Undo where historical references prevent deletion. User Management remains authoritative. No migrations, new endpoint routes, app dependencies, OPERA writes, Task Sheet changes, owner DB writes/restart or deployment were performed.

## Browser/PDF proof

Before screenshots are retained from the preceding disposable 274-room run; after screenshots use the same representative fixture with English shift labels. Neither captures owner guest data.

- Before desktop: `artifacts/hk-simple/before-desktop.png`.
- Before mobile: `artifacts/hk-simple/before-mobile.png`.
- Inline consent after: `artifacts/hk-simple/01-inline-consent.png`.
- Saved floor after: `artifacts/hk-simple/02-floor-saved-desktop.png`.
- Supervisor after: `artifacts/hk-simple/03-supervisor-saved-desktop.png`.
- Mobile after: `artifacts/hk-simple/05-attendant-mobile.png`, `06-supervisor-mobile.png`.
- Browser results and synthetic saved-room expectations: `artifacts/hk-simple/result.json`.
- Actual A4 PDFs and extracted text verification: `artifacts/hk-simple/supervisor-master.pdf`, `attendant-1.pdf`, `attendant-2.pdf`, `attendant-3.pdf`, `pdf-verification.json`.

The real-browser flow covers Manager login; visible unscheduled SPV; explicit inline Add to Shift & Assign for Floor 02; inline attendance/room assignment without configuration; Supervisor login; 20 rooms to one Room Attendant; 30 rooms distributed 10/10/10; WebSocket updates; print independent of screen filters; all three Room Attendant logins; reload/shift scope and mobile. It also scans operational text for rejected Indonesian labels. Only explicitly chosen staff are scheduled; SPV HK 2 remains Not Scheduled in the primary flow. Production request limits remain enabled and test phases respect their windows.

PDF text is compared with saved DB-derived IDs, room totals and signature fields. The master covers 100 floor rooms (30 assigned and 70 unassigned); each Room Attendant PDF contains exactly that person's 10 rooms. All pages are A4 portrait.

## Files changed for this correction

- Atomic composition/Undo: `apps/api/src/housekeeping-worksheet.ts`, `packages/contracts/src/index.ts`, `apps/web/src/worksheet-model.ts`.
- English status labels: `apps/api/src/housekeeping-eligibility.ts`, `apps/web/src/housekeeping-labels.ts`.
- Daily UX/print: `apps/web/src/pages/HousekeepingWorksheet.tsx`, `FloorAssignment.tsx`, `BulkDistribution.tsx`, `WorksheetPrint.tsx`, `HousekeepingWorksheet.css`. The prior ShiftControls translation was restored to its English baseline; it is no longer rendered by the daily worksheet.
- Tests: new `tests/housekeeping-inline-shift.test.ts`, adapted `tests/worksheet-frontend.test.tsx`, representative `tests/housekeeping-usability-fixture.ts`, and existing/new Housekeeping browser/PDF scripts.
- Documentation: `docs/HOUSEKEEPING.md`, this report, `CHANGELOG.md`.

## Final validation

| Check | Result |
| --- | --- |
| Lint | PASS |
| TypeScript, frontend and compiled server build | PASS |
| Full unit/API/frontend suite | PASS: 258 tests, 20 files |
| Existing worksheet browser smoke | PASS: 33 checks |
| Existing operational browser smoke | PASS: 19 checks |
| Updated 274-room real-login browser flow | PASS: 34 checks; zero page exceptions, failed requests or unexpected HTTP errors |
| English-only operational labels | PASS: source and real-browser text checks |
| PDF room IDs, saved totals, signatures and A4 dimensions | PASS: all four exported PDFs |
| Mobile layout | PASS: 390px viewport, no page-level horizontal overflow |
| Owner configuration, package dependencies and historical migration files | Unchanged |

The selected-date/shift actions, transaction failure rollback, idempotent replay, concurrent revisions, permission rejection and combined Undo attendance audit are covered by the new tests. Existing local APIs and advanced settings are retained. Application activation on the owner's instance is left to its next authorized start.

## Remaining acceptance

Validation is local and uses disposable databases. The owner's running database and application were not restarted or modified by test fixtures. Live OPERA entitlement/data, a separate real mobile device, production deployment and printer hardware are not acceptance-tested here. Stored user-entered names and shift definitions are preserved rather than translated automatically.
