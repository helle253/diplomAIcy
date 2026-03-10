# Press Delay with Jitter — Design

**Issue:** #3 — feat: press delay (w/ jitter)
**Date:** 2026-03-10

## Goal

Add configurable delivery delay with random jitter to the MessageBus so agent press feels natural rather than instant. Centralizes all delivery timing in one place.

## MessageBus Changes

- Constructor accepts `{ pressDelayMin?: number, pressDelayMax?: number }` (defaults: 0, 0 — no delay, preserving current behavior).
- `send(message)` queues a `setTimeout` with a random duration in `[min, max]`, then calls listeners when it fires.
- Timestamps are stamped at send time (not delivery time) — the delay simulates transit, not composition.
- New `destroy()` method clears all pending timers (for clean shutdown and tests).
- Messages are still stored in the internal array immediately on `send()` (for `getMessagesFor()` queries) — only listener notification is delayed.

## Config Flow

- `GameManager` accepts `pressDelayMin` / `pressDelayMax` in its constructor options, passes them to `MessageBus`.
- `server.ts` reads `PRESS_DELAY_MIN` and `PRESS_DELAY_MAX` env vars, passes to `GameManager`.
- Defaults: both 0 (instant delivery, backward compatible).

## Remote Adapter Cleanup

- Remove `PHASE_STAGGER_MAX` logic from `remote-adapter.ts` — the bus delay now covers this.
- Keep `MESSAGE_BATCH_DELAY` in place (that's LLM batching, not delivery pacing).

## Testing

- Unit tests for MessageBus: verify delayed delivery, jitter range, destroy cleanup.
- Existing tests unaffected (defaults to 0 delay).

## Approach

Delayed Dispatch — each message gets its own independent timer. `send()` returns immediately (fire-and-forget), listeners receive the message asynchronously after the delay. Minimal changes to external interfaces.
