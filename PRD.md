# Product Requirements Document (PRD): FlashLock Engine

## 1. System Overview
FlashLock is a high-concurrency flash-sale reservation and checkout engine designed to handle extreme traffic spikes (e.g., 5,000+ concurrent requests for 100 items) with zero overselling, zero race conditions, and automatic inventory recovery when temporary holds expire. It includes a real-time Chaos & Load Simulation Dashboard to visually and mathematically prove data consistency under stress.

## 2. User Roles & Actors
| Actor | Description | Permissions |
| :--- | :--- | :--- |
| **Authenticated Buyer** | End-user attempting to reserve and purchase stock. | View sale status, create 1 active hold (max 2 items), submit payment for active hold, cancel hold. |
| **Admin / Simulator** | Developer or portfolio reviewer testing the system. | Reset sale state, configure stock counts, trigger concurrent bot waves, adjust mock payment failure rates. |
| **Background Reaper** | Internal system worker/process. | Scan and expire stale `HELD` reservations, restore stock atomically to the available pool. |
| **Payment Webhook** | Simulated external payment gateway (Stripe-like). | Asynchronously notify the engine of `payment.succeeded` or `payment.failed` events. |

## 3. Functional Requirements (P0 - MVP)

### 3.1 Inventory Initialization & State Invariant
* **User Story:** As an Admin, I can initialize a flash sale with a fixed quantity of stock (`N` items) and a start timestamp.
* **Core Invariant:** At every millisecond of system operation, the following equation MUST hold true:
  `Available_Stock + Held_Stock + Sold_Stock == Initial_Stock`
* **Acceptance Criteria:**
  * Given a sale initialized with `100` items, when queried before the sale starts, `Available = 100`, `Held = 0`, `Sold = 0`.
  * Any reservation attempt before `sale_start_time` is rejected with `403 Sale Not Started`.

### 3.2 Atomic Stock Reservation (The "5-Minute Hold")
* **User Story:** As a Buyer, I can reserve up to 2 units of an item for 300 seconds so I have time to complete payment without losing my item to someone else.
* **Acceptance Criteria:**
  * **Given** `Available_Stock >= Requested_Qty` (where `Requested_Qty` is 1 or 2) AND the user has no existing active hold or completed purchase for this sale:
  * **When** the user sends `POST /api/v1/sales/:id/reserve` with an `Idempotency-Key`:
  * **Then** the system atomically decrements `Available_Stock`, increments `Held_Stock`, creates a Reservation record with `status = HELD` and `expires_at = NOW + 300s`, and returns `201 Created` in under `50ms` (p95).
* **Edge Cases & Error States:**
  * **Duplicate Click / Multi-Tab:** If the same user submits a second request while holding an active reservation, return `200 OK` with the *existing* reservation details (do not deduct additional stock).
  * **Partial Stock:** If `Requested_Qty = 2` and `Available_Stock = 1`, reject immediately with `409 Conflict (Insufficient Stock)` and do not deduct the remaining 1 unit.
  * **Sold Out:** If `Available_Stock == 0`, reject with `410 Gone (Sold Out)` (or `409` if items are still in `HELD` state and might return to the pool).

### 3.3 Checkout & The Expiration Race Condition
* **User Story:** As a Buyer with an active `HELD` reservation, I can initiate payment and finalize my order.
* **Acceptance Criteria:**
  * **Given** a reservation with `status = HELD` and `NOW < expires_at`:
  * **When** the user calls `POST /api/v1/reservations/:id/pay`:
  * **Then** the reservation transitions to `PAYMENT_PENDING` and its TTL is extended by `60 seconds` to prevent background expiration while the payment gateway is processing.
  * **When** the Payment Webhook fires `payment.succeeded`:
  * **Then** the reservation transitions to `CONFIRMED`, `Held_Stock` is decremented, `Sold_Stock` is incremented, and a permanent Order record is written to PostgreSQL.
* **Edge Cases & Error States:**
  * **Payment Fails:** If the webhook returns `payment.failed`, transition reservation to `EXPIRED` (or revert to `HELD` if time remains) and atomically restore the units back to `Available_Stock`.
  * **Late Webhook After Hard Timeout:** If a webhook arrives with `payment.succeeded` *after* the reservation was already reaped into `EXPIRED`, the system must NOT increment `Sold_Stock`. It logs a `LATE_PAYMENT_REFUND_REQUIRED` event and triggers an automatic mock refund.

### 3.4 Background Hold Expiration (The Reaper)
* **User Story:** As the System, I must automatically reclaim stock from abandoned carts so legitimate buyers can purchase them.
* **Acceptance Criteria:**
  * Every `1 second`, the system identifies reservations where `status == HELD` and `NOW >= expires_at`.
  * For each expired reservation, the system atomically transitions status to `EXPIRED`, decrements `Held_Stock`, and increments `Available_Stock` by the reserved quantity.

### 3.5 Real-Time Chaos & Load Simulation Dashboard
* **User Story:** As a Reviewer/Developer, I can trigger a simulated flash-sale stampede from a web UI and watch real-time telemetry verify zero overselling.
* **Acceptance Criteria:**
  * Dashboard displays live counters via Server-Sent Events (SSE): `Total Stock`, `Available`, `Held (Active Carts)`, `Sold`, and `Invariant Check (PASS/FAIL)`.
  * Includes controls to trigger:
    * *"Spawn 1,000 Concurrent Buyers (100 Stock)"*
    * *"Simulate 30% Cart Abandonment / Timeout"*
    * *"Inject Late Payment Webhook Race Condition"*

## 4. Non-Functional Requirements
* **Concurrency & Throughput:** Must handle a burst of `1,000` concurrent reservation requests on a single local node without a single database deadlock or stock drift.
* **Latency:** Reservation endpoint (`/reserve`) p95 latency under `50ms` by offloading hot-path locks to Redis Lua scripts rather than row-level SQL locks.
* **Idempotency:** All state-mutating endpoints (`/reserve`, `/pay`, `/webhook`) must be strictly idempotent.

## 5. Out of Scope (Non-Goals for v1)
* Multi-SKU shopping carts (each flash sale targets a single high-demand SKU).
* Real third-party payment gateway integration (Stripe SDK is replaced by our deterministic Chaos Payment Simulator).
* User registration, password reset, and email notifications (users are simulated via pre-signed JWT tokens).
* Physical shipping address validation or tax calculation.
