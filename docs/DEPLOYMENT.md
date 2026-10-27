# Single-server deployment

The README intentionally exposes two mutually exclusive deployment choices: native Fastify or Docker Compose. Production application traffic always goes to Fastify. Vite is a build tool; its optional development server is not part of either deployment.

## Build and runtime boundaries

- `npm run build`: type-check the entire project, build React with Vite, then bundle the Fastify backend with esbuild. Shared contracts are compiled into the server bundle; no runtime TypeScript loader is needed.
- `dist/server/index.js`: Fastify entry point. `dist/server/migrate.js` and `dist/server/seed.js` are optional maintenance entry points.
- `dist/public/`: React HTML, static assets and favicon. This is the only static root served by Fastify.
- `dist/migrations/`: SQL migration payload copied with the deployable build. It is not served publicly.
- `npm start`: Node runs the compiled server. The source tree and development dependencies are unnecessary at runtime.
- Docker separates dependency installation, application build, production-dependency pruning and runtime into distinct stages. The runtime runs as the unprivileged `node` user and starts Node directly so it receives shutdown signals.

One port handles HTML/assets, REST, OpenAPI and `/api/ws`. Browser WebSocket URLs derive `ws`/`wss` and host/port from `location`. React Router internal navigation does not reload the document or replace the WebSocket. HTML requests to nested SPA routes receive the built index; missing API/assets never fall back to HTML.

## Configuration

No `.env` file is required for local defaults. Empty optional values in `.env.example` mean automatic/default selection.

| Setting | Default / rule |
| --- | --- |
| `PORT` | `3000`; integer 1–65535; also controls Compose application mapping and health check |
| `HOST` | Native `127.0.0.1`; container `0.0.0.0` internally, published on host loopback |
| `APP_ORIGIN` | `http://localhost:$PORT`; exact canonical origin, without a path or trailing slash |
| `APP_MODE` | `demo` locally, `server` when `NODE_ENV=production` |
| `DATABASE_URL` | Absent: native persistent PGlite. Present: PostgreSQL, including a native server without Docker. Compose supplies its internal PostgreSQL URL. |
| `LOCAL_DB_PATH` | `./data/demo`; back up this directory while the embedded app is stopped |
| `LOCAL_DEMO` | Optional legacy selector. `true` conflicts with a PostgreSQL URL; `false` requires a URL. Normally leave it blank. |
| `DEMO_PASSWORD` | Optional 12+ character initial demo password; otherwise generated and printed once |
| `NODE_ENV=production` | Requires `APP_MODE=server`, PostgreSQL, HTTPS origin, `COOKIE_SECURE=true`, and a 64-hex-character `ENCRYPTION_KEY` |
| `ENCRYPTION_KEY` | AES-GCM key required for real OHIP configuration; never commit a real key |
| `OHIP_ALLOWED_HOSTS` | Exact approved HTTPS gateway hostnames; existing OHIP security checks are retained |
| `POSTGRES_PASSWORD` | Compose development default `local-development-only`; set a unique secret for a real server |

Production configuration is checked before database startup and before HTTP binding. HTTPS origin configuration assumes TLS termination at the deployment boundary; local defaults deliberately use HTTP demo mode. A build served by Fastify is used in both modes, regardless of `NODE_ENV`. Optional `npm run dev` remains a separate developer workflow and is not needed for deployment.

## Database lifecycle

Migrations run automatically at startup in a transaction. An advisory transaction lock serializes even the first migration-table creation across PostgreSQL processes. Applied versions are recorded once. The same migrations run on PostgreSQL and the local embedded engine.

Default demo mode seeds **only a database with no users**, using labeled synthetic data and one initial password. Existing databases are preserved. `APP_MODE=server` and `NODE_ENV=production` never invoke automatic demo seed; the compiled seed CLI also refuses those settings. Server onboarding/identity provisioning is intentionally separate from demo bootstrapping.

Native persistence is the configured embedded database directory or the externally managed PostgreSQL database. Docker persistence is the `hospitality-db` named volume. Stopping/restarting/recreating application containers retains it. Removing the volume deletes database data; deployment instructions never require volume deletion. Do not point multiple native processes at the same embedded directory. Native and Docker defaults are independent data stores.

The application waits for migration and optional demo bootstrap before listening. Compose waits for PostgreSQL readiness before starting the application. Worker shutdown waits for its active tick and closes WebSockets/database connections. PostgreSQL is reachable only on the private Compose network by default. When an existing deployment already owns the application port, stop it before starting the alternative; the app does not silently choose a different port.

## Validation

See [VALIDATION.md](VALIDATION.md) for executed checks. `scripts/browser-smoke.mjs` exercises the compiled server on port 3000, keeps the browser open while the server restarts, verifies durable task/session data, observes WebSocket reconnect and subsequent realtime updates, and refreshes a nested SPA URL. It refuses to run native tests against an occupied port.

Docker browser testing is restricted to the isolated `hospitality-deploy-validation` Compose project. It uses the same browser assertions and restarts that project's application container. Separate native and Docker JSON reports record frontend HTML hashes for equivalence checks. Test artifacts are ignored under `artifacts/`; no runtime test endpoint or administrative backdoor was added.
