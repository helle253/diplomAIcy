import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Power, PhaseType, Season, Message } from '../engine/types.js';
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
      const bus = makeBus(1000, 1000);
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
      expect(received).toHaveLength(0);

      // Delivered by max
      vi.advanceTimersByTime(max - min + 1);
      expect(received).toHaveLength(1);
    });

    it('stores message immediately (getMessages works before delivery)', () => {
      const bus = makeBus(5000, 5000);
      bus.send(makeMsg());

      expect(bus.getMessages()).toHaveLength(1);
    });

    it('stamps timestamp at send time, not delivery time', () => {
      const bus = makeBus(5000, 5000);
      const received: Message[] = [];
      bus.onMessage((msg) => received.push(msg));

      const sendTime = Date.now();
      bus.send(makeMsg());

      vi.advanceTimersByTime(5000);

      expect(received).toHaveLength(1);
      expect(received[0].timestamp).toBe(sendTime);
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
