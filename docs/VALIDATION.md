# Validation ? single-server deployment

Executed on 2026-10-27 (Asia/Jakarta), Windows / Node.js 24.14.1, npm 11.19.0, installed Chrome via Playwright, and Linux Node 24 / PostgreSQL 17 in an isolated Docker Compose project.

| Required check | Result | Evidence |
| --- | --- | --- |
| npm install | PASS | Actual root installation completed; 0 reported dependency vulnerabilities |
| npm run build | PASS | Strict TypeScript check, Vite React output, compiled JavaScript backend and copied migrations in dist/ |
| npm start | PASS | Actual command ran node dist/server/index.js, without tsx or Vite |
| localhost:3000 browser / health | PASS | HTML, API health and authenticated operations loaded on the same origin |
| SPA navigation | PASS | One top-level document load across all internal menu navigation; no WebSocket close/replacement during navigation |
| Nested SPA refresh | PASS | Direct /operations/reservations navigation and browser reload both loaded the React route |
| Native WebSocket recovery | PASS | Browser stayed open through server restart, reconnected, received a subsequent backend mutation without refresh |
| Native persistence | PASS | Assigned/acknowledged task and authenticated session survived process restart using the same embedded database directory |
| Docker one-command startup | PASS | docker compose up --build -d built the multi-stage image and started private PostgreSQL and Fastify; both healthy |
| Docker runtime contents | PASS | Built server present; source tree, Vite, tsx and TypeScript packages absent |
| Docker network | PASS | Only 127.0.0.1:3000 published; PostgreSQL 5432 is container-network-only; both services restart unless stopped |
| Docker WebSocket recovery | PASS | Browser stayed open through app-container restart, reconnected, and received subsequent data |
| Docker persistence | PASS | Task/session survived app restart; original credentials and assigned/acknowledged task also survived replacement of BOTH app and PostgreSQL containers while retaining the named volume |
| Native/Docker equivalence | PASS | Same browser assertions pass; frontend HTML SHA-256 matches exactly |
| Production validation / no seed | PASS | Five configuration tests plus actual compiled server/seed process checks; invalid production settings rejected before database creation |
| Existing test suite | PASS | 49 tests: all original 44 plus 5 deployment configuration tests |
| Lint | PASS | npm run lint |

The default local native deployment now uses persistent PGlite automatically; Docker uses PostgreSQL. Default demo mode initializes only a database without users, and never resets existing accounts. Server/production mode does not seed. Migrations run automatically, use a transaction/advisory lock, and preserve one applied-version record across restarts.

Browser reports are generated as ignored artifacts: browser-native-result.json, browser-docker-result.json, deployment-equivalence.json, and docker-volume-result.json. Each browser report records one document load for SPA navigation and three total after the two deliberate nested-route navigation/reload checks. Both reports record zero page errors. The matching frontend hash is 7000e053d5e3714fea5520641b6832d9a67706c5ded46e6752373429582957a4.

Native and Docker tests use port 3000 sequentially. An initial native harness run detected a still-running manually started server; the harness now refuses an occupied port, and validation was rerun against its own isolated database. Missing API routes may return 401 before authentication; missing assets return 404. Neither receives SPA HTML. Test identifiers are unique so rerunning Docker tests preserves existing data.

The full existing tests retain tenant/property isolation, authentication, pagination, retry safety, WebSocket authorization/replay, frontend loading/error/empty states, and official Oracle fixture checks. These are local tests; Oracle credentials/property ingestion, streaming, physical mobile devices, production TLS infrastructure, HA/load, backups and a production security assessment remain untested. No remote push or production deployment/configuration change was performed. Validation containers are stopped after checks, with their image and named development volume retained.

See [deployment details](DEPLOYMENT.md), [operational/Oracle boundaries](OPERATIONS.md), and [README](../README.md).
