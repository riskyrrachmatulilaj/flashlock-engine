# FlashLock Engine — Atomic Implementation Plan (`TODO.md`)

> **Instructions for AI Coding Agent:** 
> Complete one checkbox at a time. Before writing code for a task, read `PRD.md` and `ARCHITECTURE.md`. After completing a task, run the verification command or write the specified test before checking the box `- [x]`.

## Phase 0: Project Scaffolding & Infrastructure
- [x] **0.1 Initialize TypeScript & Fastify Project:** Set up `package.json`, `tsconfig.json` (`strict: true`), Fastify v5, `zod`, `fastify-type-provider-zod`, `ioredis`, `drizzle-orm`, `postgres`, and `vitest`.
- [x] **0.2 Docker Compose Setup:** Create `docker-compose.yml` spinning up PostgreSQL 16 (port `5432`) and Redis 7/8 (port `6379`) with healthchecks, plus `.env.example` and `src/config/env.ts` validator.
- [x] **0.3 Database Schema & Migrations:** Implement `src/db/schema.ts` (`sales`, `reservations`, `orders`) and generate/push initial Drizzle schema to PostgreSQL.

## Phase 1: Redis Lua Engine (The Atomic Core)
- [x] **1.1 Write `reserve_stock.lua`:** Implement atomic Lua script that checks sale start time, checks user idempotency in `sale:{saleId}:user_holds`, verifies `available_stock >= qty`, decrements `available_stock`, increments `held_stock`, stores reservation hash (`HELD`), and adds `resId` to `sale:{saleId}:expiry_queue` ZSET.
- [x] **1.2 Write `reap_expired.lua`:** Implement atomic Lua script that queries `sale:{saleId}:expiry_queue` for scores `<= now`, loops through expired `resId`s, transitions `HELD` or timed-out `PAYMENT_PENDING` to `EXPIRED`, decrements `held_stock`, increments `available_stock`, and removes from ZSET.
- [x] **1.3 Write `confirm_order.lua`:** Implement atomic Lua script handling payment webhook outcomes:
  - On `payment.succeeded`: If status is `HELD` or `PAYMENT_PENDING`, transition to `CONFIRMED`, decrement `held_stock`, increment `sold_stock`, and remove from ZSET. If status is already `EXPIRED`, return `LATE_PAYMENT_DETECTED` without touching stock counters.
  - On `payment.failed`: Transition to `EXPIRED`, decrement `held_stock`, increment `available_stock`, and remove from ZSET.
- [x] **1.4 Redis Client & Unit Tests for Lua Scripts:** Create `src/redis/client.ts` loading all 3 Lua scripts via `ioredis.defineCommand()`. Write Vitest unit tests verifying each Lua script directly against Redis.

## Phase 2: Core Backend APIs & Background Reaper
- [x] **2.1 Sale Initialization Module (`POST /api/v1/sales`):** Create endpoint that inserts a sale into PostgreSQL and initializes the `sale:{saleId}:state` hash in Redis (`total_stock`, `available_stock`, `held_stock=0`, `sold_stock=0`).
- [x] **2.2 Auth & Sliding-Window Rate Limiter Middleware:** Implement `x-user-id` header extraction and Redis sliding-window rate limiter (max 5 requests / 10s per user).
- [x] **2.3 Reservation Endpoint (`POST /api/v1/sales/:id/reserve`):** Connect route to `reserve_stock.lua`, persist new reservations to PostgreSQL, and map Lua return codes to HTTP `201`, `200`, `403`, `409`, and `410`.
- [x] **2.4 Background Reaper Worker (`src/workers/reaper.worker.ts`):** Build a non-overlapping 1-second interval worker that invokes `reap_expired.lua` for active sales and syncs `EXPIRED` status updates to PostgreSQL in batches.

## Phase 3: Chaos Payment Simulator & Webhook Race Handling
- [x] **3.1 Checkout Initiation (`POST /api/v1/reservations/:id/pay`):** Verify hold ownership, transition Redis reservation status to `PAYMENT_PENDING`, extend ZSET expiry by `+60s` grace window, and trigger the async Chaos Payment Simulator.
- [x] **3.2 Chaos Payment Simulator & Webhook (`POST /api/v1/webhooks/payment`):** Build simulator with configurable delay (`500ms-3000ms`) and failure rate. Implement webhook receiver that executes `confirm_order.lua`, creates durable records in PostgreSQL `orders` table, and logs `REFUNDED_LATE` when a late webhook loses to the Reaper.

## Phase 4: Concurrency Verification Suite (Proof of Work)
- [x] **4.1 The 1,000-Buyer Stampede Test (`tests/invariant.test.ts`):** Write an automated Vitest test that initializes a sale with `100` stock, fires `1,000` concurrent `Promise.all` reservation requests (random qty 1 or 2), simulates 30% cart abandonment and 70% checkout, and asserts that `Available + Held + Sold === 100` at every stage with `0` oversold units.
- [x] **4.2 The Late-Webhook Race Test (`tests/race-condition.test.ts`):** Write a deterministic test where a reservation expires and is reaped at `t = 300s`, followed by a `payment.succeeded` webhook arriving at `t = 301s`. Assert that `Sold_Stock` does not increment and status becomes `REFUNDED_LATE`.

## Phase 5: Real-Time SSE Telemetry & Chaos Dashboard UI
- [x] **5.1 SSE Telemetry Stream (`GET /api/v1/sales/:id/stream`) & Stampede Trigger (`POST /api/v1/sales/:id/stampede`):** Stream Redis state counters every `250ms` along with a boolean `invariantValid` flag. Add an endpoint that spawns virtual buyer workers on the backend.
- [x] **5.2 React + Tailwind Chaos Dashboard (`web/`):** Build a single-page dashboard featuring:
  - Live progress bars for `Available`, `Held`, and `Sold` stock.
  - A glowing green/red badge displaying the live mathematical equation: `Available + Held + Sold == Initial Stock`.
  - One-click buttons: **"Initialize 100 Stock"**, **"Fire 1,000 Concurrent Buyers"**, and **"Inject Late Payment Race Condition"**.
