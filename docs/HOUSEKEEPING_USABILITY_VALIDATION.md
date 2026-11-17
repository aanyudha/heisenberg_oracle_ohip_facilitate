# Housekeeping usability delivery — 2026-11-17

## Root cause and scope

The card and selector represented different states. Cards showed registered staff and retained assignment references. The floor dropdown filtered to active, correctly classified/property-authorized staff explicitly marked available for the selected business date/shift. The old UI hid excluded options and collapsed distinct causes into “Unavailable,” making a valid roster restriction look like a broken selector.

A read-only transaction against the configured PostgreSQL confirmed SPV HK 1, SPV HK 2 and Attendant HK 1 had the correct Housekeeping classifications and property grants. SPV HK 1 and Attendant HK 1 had available roster entries only on **2026-11-12 and 2026-11-13** for Shift Pagi. SPV HK 2 had no available entries. Those entries do not authorize assignments on another date/shift. The screenshot's selected date was not independently established; the exact dated entries above are the verified evidence. No owner staff/roster/assignment data was corrected automatically.

## Changes

- Existing worksheet/roster responses distinguish inactive, wrong role, wrong property, not scheduled, explicitly off shift and no longer registered. Scheduled Attendants additionally explain a required or unavailable team Supervisor. Staff inspection stays within the current tenant/property candidates and authorized retained assignment references.
- The floor dropdown shows eligible Supervisors as selectable and other named staff as disabled explained options. **Atur Staf Shift** opens/focuses the existing editor directly. Registration never silently means present.
- Available Attendants are prioritized. Unallocated staff who cannot receive work appear under **Staf belum bertugas** below working teams; inactive/unavailable staff with saved work remain visible and actionable. Existing assignments are retained.
- Daily labels are Indonesian. Coverage totals, saved team allocations and rooms awaiting allocation are clearly separated. Missing credits display `-`; explanations appear in workload details. Empty task placeholders and broad non-actionable credit/staff warnings are removed. Actual conflicts, unavailable room data, missing assigned rooms and save errors remain visible.
- Single/bulk floor changes, room selection/distribution, preview, atomic save, revision validation, rollback, Undo and WebSocket reuse the existing implementation. Floor replacement/removal preserves assigned work as explicitly explained retained-work exceptions.
- Printing still obtains the canonical saved revision, ignores board filters, blocks during autosave and revalidates before PDF export. Empty workloads explicitly say **Belum mendapat kamar** rather than implying completed work.

No application features, endpoint routes, runtime dependencies or migrations were added. Historical SQL, OPERA Task Sheets, Oracle guards, authentication/RBAC and unrelated modules were not redesigned. There was no owner application restart, owner DB migration/reset/write, push or production deployment.

## Browser/database/PDF evidence

The disposable fixture contains 274 room snapshots with explicit validated floor mappings, two registered Supervisors, three primary Attendants and additional unscheduled/off-shift/inactive cases. Users are registered through the existing User Management API; fixture values are not hardcoded into runtime logic. Room data is explicitly synthetic/DEMO, not represented as real OPERA evidence.

| Flow | Result |
| --- | --- |
| A — Manager schedules staff and selects SPV HK 1 for Floor 02 | PASS: API/DB floor ownership and Supervisor card update |
| B — Supervisor logs in, sees Floor 02 and assigns 20 rooms to one Attendant | PASS: exactly 20 active saved rows; print blocked while autosave pending |
| C — Select 30 rooms, preview and distribute to three Attendants | PASS: 10/10/10 saved rows, 30 unique room owners, totals update |
| D — Supervisor Master print | PASS: all 30 assigned rooms grouped correctly plus 70 unassigned covered rooms |
| E — Each Attendant report | PASS: exact saved room list, 10 each; active board filter does not remove print rows |
| F — Unavailable/inactive staff | PASS: validated reasons, disabled choices and authorized correction action; no manufactured attendance |
| G — Reload, shifts, WebSocket and desktop/mobile | PASS: saved assignments retained; Manager updates without reload; each Attendant login sees only their own 10 rooms |

The browser suite completed **30 checks** with zero page exceptions, failed requests or unexpected HTTP errors. Unauthenticated `/api/me` 401s preceding login are expected and retained in the console evidence. Tests wait for unchanged per-IP rate-limit windows instead of weakening rate limiting.

Actual exported PDF text was extracted with pypdf and compared with the saved DB-derived room IDs:

| PDF | Saved room IDs matched | Pages | Format |
| --- | --- | --- | --- |
| Supervisor master | 100 coverage rooms = 30 assigned + 70 unassigned | 7 | A4 portrait |
| Attendant HK 1 | Exactly that Attendant's 10 rooms | 1 | A4 portrait |
| Attendant HK 2 | Exactly that Attendant's 10 rooms | 1 | A4 portrait |
| Attendant HK 3 | Exactly that Attendant's 10 rooms | 1 | A4 portrait |

The existing operational smoke separately verifies print tables fit without clipping and a longer Attendant PDF spans multiple pages with signatures. A settled mobile check uses a fresh 390×844 browser context with equivalent saved assignments: document width **390px**, viewport **390px**, closed sidebar right edge **0px**, zero page exceptions and 30 saved room allocations. The additional capture avoids recording the existing sidebar halfway through its viewport-resize animation.

Evidence under ignored `artifacts/`:

- `hk-usability/result.json` and `hk-usability-browser.log`: 274-room flows, errors and PDF expected IDs.
- `hk-usability/02-floor-saved-desktop.png`, `03-supervisor-saved-desktop.png`, `05-attendant-mobile.png`, `07-supervisor-mobile-settled.png`, `08-supervisor-mobile-full.png`: browser screenshots.
- `hk-usability/supervisor-master.pdf`, `attendant-1.pdf`, `attendant-2.pdf`, `attendant-3.pdf`, `pdf-verification.json`: actual PDF output and text/size verification.
- `hk-usability/mobile-layout-check.json`: settled mobile metrics.
- `housekeeping-smoke.json`: existing worksheet browser smoke, **33 checks**, zero browser errors.
- `housekeeping-operational-smoke.json`: existing 120-room operational browser smoke, **19 checks**, zero browser errors.
- `hk-all-tests.txt`: complete unit/API/frontend regression suite.

## Validation and limitations

Lint and TypeScript/frontend/server build pass. The full suite passes **251 tests across 19 files**. API/frontend tests cover roster transitions, inactive/wrong-role/wrong-property history, explicit scheduling, unavailable Supervisors, saved print scope, safe floor replacement/removal, concurrent stale revisions, duplicate ownership and tenant/property/role restrictions. All databases used for mutations and browser acceptance are disposable. Extracted PDF totals and Attendant/Supervisor signature fields are verified in addition to room IDs and A4 page sizes.

Owner-database investigation was read-only and did not poll Oracle. Live OPERA data/entitlements, production deployment, a separate real mobile device and physical printer hardware are **NOT TESTED**. This change adds no schema migration. The build is prepared for the next authorized application start; the operator still selects who is actually present for the intended date/shift.

## Changed files

| Area | Files |
| --- | --- |
| Eligibility and existing APIs | new `apps/api/src/housekeeping-eligibility.ts`, `apps/api/src/housekeeping-worksheet.ts`, `apps/api/src/housekeeping.ts`, `packages/contracts/src/index.ts` |
| Daily workflow and print presentation | new `apps/web/src/housekeeping-labels.ts`, `apps/web/src/pages/HousekeepingWorksheet.tsx`, `HousekeepingWorksheet.css`, `FloorAssignment.tsx`, `ShiftControls.tsx`, `BulkDistribution.tsx`, `WorksheetPrint.tsx` |
| Regression tests/fixtures | new `tests/housekeeping-usability-fixture.ts`, new `tests/housekeeping-usability.test.ts`, `tests/worksheet-frontend.test.tsx` |
| Browser/PDF acceptance | new `scripts/housekeeping-usability-smoke.ts`, new `scripts/verify-housekeeping-usability-pdf.py`, updated existing `scripts/housekeeping-smoke.ts` and `scripts/housekeeping-operational-smoke.ts` selectors for localized labels |
| Documentation | `docs/HOUSEKEEPING.md`, `CHANGELOG.md`, this report |

Run `npm.cmd run lint`, `npm.cmd run build`, `npm.cmd test`, both existing Housekeeping smoke commands, `node --import tsx scripts/housekeeping-usability-smoke.ts` and `python scripts/verify-housekeeping-usability-pdf.py`. PDF extraction uses an isolated ignored tool install (`python -m pip install --target artifacts/hk-pdf-tools pypdf==7.1.0`); application dependencies remain unchanged.
