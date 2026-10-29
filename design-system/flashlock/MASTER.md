# FlashLock design system

## Source and scope
UI UX Pro Max guidance from https://github.com/nextlevelbuilder/ui-ux-pro-max-skill, applied to existing React + Tailwind dashboard. Downloaded skill tooling to temporary storage, not runtime dependencies.

Verified searches via `py -3 .../scripts/search.py`:
- `operations dashboard --design-system`: Minimalism & Swiss Style; technical Fira Sans / Fira Code typography; contrast, clear hierarchy, subtle hover.
- Retry `real-time monitoring dashboard --design-system`: real-time operations structure and truthful live/stale labels fit. Luxury typography result rejected as unsuitable.
- `state updates accessibility --stack react`: polite announcements and batched state updates.

## Direction
Light operations console with warm neutral canvas, dark navigation, indigo actions, and semantic mint / amber / blue inventory categories. Minimal grid and restrained shadows; no decorative charts or invented metrics. Technical system-font fallbacks keep UI usable without font network requests.

## Information hierarchy
1. Workspace and connection status.
2. Current sale and inventory conservation proof.
3. Available, held, sold counters with text labels and proportions.
4. Ordered setup, load, and isolated race actions.
5. Client event stream and last received time.

## Interaction rules
- Minimum 44px controls, visible keyboard focus, no hover-only meaning.
- Busy and unavailable actions explain state. API failures stay visible and dismissible.
- Idle values use em dash, never fabricated zero or successful checks.
- Disconnected counters explicitly described as last known values.
- Initialization creates another sale; no deletion.
- 70% of successful holds initiate payment, not guaranteed payment success.
- Race uses isolated sale and logical time; dashboard switches to returned sale.
- Status is text plus icon, never color alone.
- Respect reduced-motion preferences. Avoid animating every SSE update.
- Layout must fit narrow mobile screens; long IDs and logs wrap.

## Validation
Frontend TypeScript/Vite build; browser checks at desktop and 375px mobile; real-service initialization, SSE and race checks where services available. Preserve backend API contracts and real telemetry.
