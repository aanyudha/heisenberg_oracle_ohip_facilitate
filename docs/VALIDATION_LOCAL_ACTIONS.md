# Validation: local UI actions and connection control

Validated locally on 2026-10-29. No production push/deployment or live Oracle request was performed. Existing runtime credentials were not changed; the deployment harness restores the original root `.env` after using isolated test configurations.

| Check | Result |
| --- | --- |
| `npm run lint` | PASS |
| `npm run build` (TypeScript, React/Vite, compiled Fastify) | PASS |
| `npm test` | PASS: 143 tests across 11 files |
| Real PostgreSQL regression suite using isolated schemas | PASS |
| `npm start` using final compiled artifacts and a separate embedded test directory | PASS: health 200, nested SPA route 200 HTML, private API 401 |
| Native embedded/PostgreSQL browser smoke | PASS |
| Docker build, config preflight, app/database health, private database port | PASS |
| Docker SPA/API/authenticated WebSocket and post-restart event/UI updates | PASS |
| Selected property and session retained across server restart | PASS |
| PostgreSQL volume data retained after container recreation | PASS |
| Credential/config mismatch rejection and mutually exclusive deployment lock | PASS |
| Live OPERA authentication, permissions and hotel data | NOT TESTED |

All 19 deployment checks passed. Native embedded, native PostgreSQL and Docker served the same frontend hash; Docker browser smoke reported zero page errors.

Regression coverage includes approved-only Oracle transport, row mouse/Enter/Space navigation, absence of Oracle write controls, local tenant/organization/property/membership lifecycle, branding reset, cross-tenant denial, self/last-administrator protections, dependency rejection and retained audit history. Connection tests cover property/global pause, independent shared-property scopes, blocked dispatch/enqueue/manual retry, persistence through app/database reopen, resume scheduling, in-flight serialization and worker snapshot rejection across pause/resume cycles.

Migration `0003_local_controls.sql` adds connection pause/archive, assignment pause/revision and a local soft-archive registry. No audit records, saved credentials or Oracle records are removed. Users are archived by tenant membership; user editing retains the existing role/property-access scope. Property archive rejects configured connections/mappings, other-user grants and active jobs/tasks. Branding deletion resets to defaults. Resume validates saved configuration locally; successful Oracle connectivity is established by subsequent read-only polling. Resume is required before connection edits/tests that perform pre-save access validation.

The Docker restart check exposed loss of the selected property when an identity background refetch failed during downtime. Cached authenticated workspace state now remains mounted for transient errors; 401 still switches to login. The browser smoke requires an actual post-restart task WebSocket event before asserting the corresponding UI refresh, so the periodic fetch fallback cannot satisfy that check alone.

Generated local evidence (ignored by Git): `artifacts/config-deployment-result.json`, `artifacts/browser-native-embedded-result.json`, `artifacts/browser-native-postgres-result.json`, `artifacts/browser-docker-result.json`, and `artifacts/npm-start-result.json`. The deployment harness removed its own Compose containers/volumes and temporary PostgreSQL container after completion. Unrelated services were not modified.
