# Press Delay with Jitter Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable delivery delay with jitter to the MessageBus so agent press arrives naturally instead of instantly.

**Architecture:** MessageBus gains a config object with `pressDelayMin`/`pressDelayMax`. On `send()`, messages are stored immediately but listener notifications are deferred via `setTimeout` with a random delay in `[min, max]`. A `destroy()` method clears pending timers. GameManager passes the config through; server.ts reads env vars.

**Tech Stack:** TypeScript, vitest, setTimeout/clearTimeout

---

## Task 1: MessageBus — add delayed delivery

**Files:**
- Modify: `src/game/message-bus.ts`
- Create: `src/game/message-bus.test.ts`

- [ ] **Step 1: Write failing tests for delayed delivery**

Create `src/game/message-bus.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Power, PhaseType, Season } from '../engine/types.js';
import { MessageBus } from './message-bus.js';

describe('MessageBus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeBus(pressDelayMin = 0, pressDelayMax = 0) {
    const bus = new MessageBus({ pressDelayMin, pressDelayMax });
    bus.phase = { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy };
    return bus;
  }

  function makeMsg(from: Power = Power.England, to: Power | 'Global' = Power.France) {
    return {
      from,
      to,
      content: 'hello',
      phase: { year: 1901, season: Season.Spring, type: PhaseType.Diplomacy },
      timestamp: 0,
    };
  }

  describe('zero delay (default)', () => {
    it('delivers messages to listeners synchronously', () => {
      const bus = makeBus();
      const received: unknown[] = [];
      bus.onMessage((msg) => received.push(msg));

      bus.send(makeMsg());

      expect(received).toHaveLength(1);
    });
  });

  describe('with press delay', () => {
    it('does not deliver to listeners immediately', () => {
      const bus = makeBus(1000, 3000);
      const received: unknown[] = [];
      bus.onMessage((msg) => received.push(msg));

      bus.send(makeMsg());

      expect(received).toHaveLength(0);
    });

    it('delivers after the delay elapses', () => {
      const bus = makeBus(1000, 1000); // fixed delay for determinism
      const received: unknown[] = [];
      bus.onMessage((msg) => received.push(msg));

      bus.send(makeMsg());
      vi.advanceTimersByTime(1000);

      expect(received).toHaveLength(1);
    });

    it('delay is within [min, max] range', () => {
      const min = 2000;
      const max = 5000;
      const bus = makeBus(min, max);
      const received: unknown[] = [];
      bus.onMessage((msg) => received.push(msg));

      bus.send(makeMsg());

      // Not delivered before min
      vi.advanceTimersByTime(min - 1);
      expect(received.length).toBeLessThanOrEqual(0);

      // Delivered by max
      vi.advanceTimersByTime(max - min + 1);
      expect(received).toHaveLength(1);
    });

    it('stores message immediately (getMessages works before delivery)', () => {
      const bus = makeBus(5000, 5000);
      bus.send(makeMsg());

      expect(bus.getMessages()).toHaveLength(1);
    });
  });

  describe('destroy', () => {
    it('cancels pending deliveries', () => {
      const bus = makeBus(1000, 1000);
      const received: unknown[] = [];
      bus.onMessage((msg) => received.push(msg));

      bus.send(makeMsg());
      bus.destroy();
      vi.advanceTimersByTime(2000);

      expect(received).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/game/message-bus.test.ts`
Expected: FAIL — `MessageBus` constructor doesn't accept config, no `destroy()` method

- [ ] **Step 3: Implement delayed delivery in MessageBus**

Modify `src/game/message-bus.ts`:

```typescript
import { Message, Phase, Power } from '../engine/types.js';

export type MessageListener = (message: Message) => void;

export interface MessageBusConfig {
  pressDelayMin?: number;
  pressDelayMax?: number;
}

export class MessageBus {
  private messages: Message[] = [];
  private listeners: MessageListener[] = [];
  private _phase: Phase | null = null;
  private pressDelayMin: number;
  private pressDelayMax: number;
  private pendingTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(config: MessageBusConfig = {}) {
    this.pressDelayMin = config.pressDelayMin ?? 0;
    this.pressDelayMax = config.pressDelayMax ?? 0;
  }

  set phase(phase: Phase) {
    this._phase = { ...phase };
  }

  get currentPhase(): Phase | null {
    return this._phase;
  }

  onMessage(listener: MessageListener): void {
    this.listeners.push(listener);
  }

  send(message: Message): void {
    this.stamp(message);
    this.messages.push(message);
    this.notifyListeners(message);
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getMessagesFor(power: Power): Message[] {
    return this.messages.filter(
      (m) =>
        m.to === 'Global' ||
        m.to === power ||
        (Array.isArray(m.to) && m.to.includes(power)),
    );
  }

  destroy(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers = [];
  }

  private notifyListeners(message: Message): void {
    if (this.pressDelayMin <= 0 && this.pressDelayMax <= 0) {
      // Zero delay — synchronous delivery (preserves existing behavior)
      for (const listener of this.listeners) {
        listener(message);
      }
      return;
    }

    const delay =
      this.pressDelayMin +
      Math.random() * (this.pressDelayMax - this.pressDelayMin);

    const timer = setTimeout(() => {
      this.pendingTimers = this.pendingTimers.filter((t) => t !== timer);
      for (const listener of this.listeners) {
        listener(message);
      }
    }, delay);

    this.pendingTimers.push(timer);
  }

  private stamp(msg: Message): void {
    if (!this._phase) throw new Error('MessageBus: phase not set');
    msg.phase = { ...this._phase };
    msg.timestamp = Date.now();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/game/message-bus.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: All existing tests pass (MessageBus constructor is backward-compatible with no args)

- [ ] **Step 6: Commit**

```bash
git add src/game/message-bus.ts src/game/message-bus.test.ts
git commit -m "feat: add press delay with jitter to MessageBus (#3)"
```

---

## Task 2: Wire config through GameManager and server

**Files:**
- Modify: `src/game/manager.ts`
- Modify: `src/ui/server.ts`

- [ ] **Step 1: Update GameManager constructor to accept and pass press delay config**

In `src/game/manager.ts`, change the constructor:

```typescript
// Before (line 81):
constructor(maxYears = 50, phaseDelayMs = 0, remoteTimeoutMs = 0) {

// After:
constructor(
  maxYears = 50,
  phaseDelayMs = 0,
  remoteTimeoutMs = 0,
  pressDelayMin = 0,
  pressDelayMax = 0,
) {
```

Change `readonly bus = new MessageBus();` (line 74) to initialize in the constructor body:

```typescript
readonly bus: MessageBus;

// In constructor:
this.bus = new MessageBus({ pressDelayMin, pressDelayMax });
```

- [ ] **Step 2: Update server.ts to read env vars and pass to GameManager**

In `src/ui/server.ts`, in the `startGame` function (after line 78):

```typescript
const pressDelayMin = parseInt(process.env.PRESS_DELAY_MIN || '0');
const pressDelayMax = parseInt(process.env.PRESS_DELAY_MAX || '0');
const manager = new GameManager(maxYears, phaseDelayMs, remoteTimeoutMs, pressDelayMin, pressDelayMax);
```

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/game/manager.ts src/ui/server.ts
git commit -m "feat: wire press delay config through GameManager and server (#3)"
```

