# FlashLock Engine

Atomic flash-sale reservations, chaos payments, live stock telemetry, and a React dashboard.

## Local development

Requires Node.js 22+, Docker Compose (or PostgreSQL 16 and Redis 7/8 running locally).

```powershell
Copy-Item .env.example .env
npm.cmd install
docker compose up -d
npm.cmd run db:push
npm.cmd run dev
```

In another terminal:

```powershell
cd web
npm.cmd install
npm.cmd run dev
```

Open the URL printed by Vite (normally http://localhost:5173). Vite proxies `/api` to the backend at http://127.0.0.1:3000. No CORS setup needed for local development.

The backend health endpoint only checks HTTP liveness, not database readiness. Both PostgreSQL and Redis must be available for dashboard actions. No mock-success fallback is used.

## Dashboard

UI guidance and interaction rules are documented in `design-system/flashlock/MASTER.md`, using UI UX Pro Max recommendations. Dashboard copy is in Indonesian; API contracts and technical statuses stay unchanged.

- **Initialize 100 Stock** creates a fresh sale; it does not delete older sales.
- **Fire 1,000 Concurrent Buyers** reserves random quantities of 1 or 2. 70% of successful holds initiate payment; 30% abandon carts. Abandoned stock is reclaimed after the default 300-second hold TTL.
- **Inject Late Payment Race Condition** creates a separate isolated sale. Actual reservation, reaper Lua, and payment webhook handlers run in sequence. The reaper receives the hold expiry as its logical clock. This accelerates the simulated t=300s / t=301s scenario without changing process time or waiting five minutes. The returned timeline is simulated; payment audit timestamps use real wall time.

Telemetry arrives as named `telemetry` SSE events every 250ms. Each event carries counters and `invariantValid`.

## Verify

```powershell
npm.cmd test
npx.cmd tsc --noEmit
cd web
npm.cmd run build
```

Backend tests use ioredis-mock and mocked PostgreSQL persistence. They do not prove real Redis batch behaviour or durable database writes. The stampede verification reaps one item per batch because the mock's Lua bridge mishandles dynamically built multi-item return tables.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/v1/sales` | Create sale (`title`, `totalStock`) |
| GET | `/api/v1/sales/:id/stream` | SSE stock telemetry |
| POST | `/api/v1/sales/:id/stampede` | Start buyers; optional `buyers` (1–5000), `checkoutRatio` (0–1) |
| POST | `/api/v1/sales/:id/race` | Isolated accelerated late-webhook demo |

## Deployment scope

Simulator/admin routes are local demonstration controls, not production-hardened admin APIs. Do not expose this app publicly without authentication, authorization, and global load limits. The per-sale stampede guard does not limit concurrent runs across distinct sales.
