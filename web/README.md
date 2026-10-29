# FlashLock dashboard

React 19 + TypeScript + Vite + Tailwind CSS 4 dashboard. All inventory values come from named `telemetry` SSE events; no mocked success or automatic sale initialization.

## Run

```powershell
cd web
npm.cmd install
npm.cmd run dev
```

Vite proxies `/api` to `http://127.0.0.1:3000`. Start backend with Redis and PostgreSQL before initializing stock. Production deployments must route `/api` to backend; Vite development proxy does not apply to built static assets.

## Controls

- **Initialize 100 Stock** creates a new sale and subscribes to its stream.
- **Fire 1,000 Concurrent Buyers** submits 1,000 buyers with `checkoutRatio: 0.7`. Request acceptance does not mean all buyers have finished; SSE remains authoritative.
- **Inject Late Payment Race Condition** runs backend's dedicated isolated sale. Logical reaper clock simulates expiration without a five-minute wait. Original sale remains intact. Dashboard switches to returned `saleId` and shows returned refund status.

Requests time out after 10 seconds. Timing out does not cancel work already accepted by backend. Errors do not generate success states. Buttons disable while requests are pending. SSE reconnects automatically and closes on sale change or unmount. Disconnected dashboard initially displays empty counters rather than invented stock.

Event log retains latest 100 client/telemetry entries, not durable backend audit history. Page reload intentionally starts disconnected; no sale is persisted or automatically created.

## Verify

```powershell
npm.cmd run build
```
