# Hospitality Operations Web V1

Choose **one** deployment method below. Both serve the same built React application, REST API and authenticated WebSocket through **Fastify at http://localhost:3000**. Do not run native and Docker deployments simultaneously on the same port. Neither method needs a Vite server or a second terminal.

## OPTION A: Run with Fastify

Requires Node.js 24 and npm. Docker and a PostgreSQL installation are not needed for the local demo.

```sh
npm install
npm run build
npm start
```

`build` produces JavaScript backend files, React static assets and migrations in `dist/`. `start` runs `node dist/server/index.js`; it never starts Vite or runs TypeScript source. By default, native mode uses a persistent embedded PostgreSQL database in `data/demo`.

## OPTION B: Run with Docker

Requires Docker Engine with Compose. No npm command is needed on the host.

```sh
docker compose up --build -d
```

Compose builds the multi-stage image, waits for its private PostgreSQL service to be ready, and starts Fastify. Only application port **3000** is published, on loopback. PostgreSQL has no published host port and persists in a named volume. Both services have health checks and restart policies. The runtime image contains built application files and runtime dependencies, without Vite, tsx or TypeScript tooling.

For both options, open **http://localhost:3000**. First startup in the default **DEMO** mode initializes an empty database with labeled sample data and prints the initial `admin@demo.local` password. Native prints it in the startup terminal; Docker records it in `docker compose logs app`. An optional `DEMO_PASSWORD` controls that first password. Restarting preserves accounts, sessions and operational changes; it does not reset or reseed existing data. No live Oracle connection is implied.

`PORT` changes the application port; without an explicit `APP_ORIGIN`, the local origin follows it automatically. Optional settings are documented in [.env.example](.env.example); neither option requires an `.env` file for its local defaults. Native can use a separately managed PostgreSQL server by setting `DATABASE_URL`. The two deployment methods use separate default databases; switching methods does not transfer records automatically.

For a real server, use `APP_MODE=server` with PostgreSQL. With `NODE_ENV=production`, startup additionally requires a valid HTTPS `APP_ORIGIN`, secure cookies and a valid encryption key. Server/production mode **never seeds demo data** and fails before opening the HTTP listener when configuration is invalid. See [configuration and deployment validation](docs/DEPLOYMENT.md).

All existing operational features remain: tenant/property authorization, dynamic branding, dashboards, reservations, tasks, housekeeping, command center, integration telemetry/recovery, and audit trail. Nested SPA routes support browser refresh; internal navigation keeps the shell and WebSocket session. [Feature coverage and Oracle integration limits](docs/OPERATIONS.md).

Verification: `npm test`, `npm run lint`, and `npm run test:browser` (after build; installed Chromium browser required). PowerShell users whose execution policy blocks `npm.ps1` can use `npm.cmd` for the same commands. [Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) · [Source files](docs/FILES.md) · [Changelog](CHANGELOG.md).
