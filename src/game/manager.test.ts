import { describe, expect, it } from 'vitest';

import { STARTING_UNITS } from '../engine/map';
import { BuildOrder, Order, OrderType, PhaseType, Power, Season } from '../engine/types';
import { GameEvent, GameManager } from './manager';

const ALL_POWERS = [
  Power.England,
  Power.France,
  Power.Germany,
  Power.Italy,
  Power.Austria,
  Power.Russia,
  Power.Turkey,
];

// ============================================================================
// Helper: a deterministic "always hold" agent using direct manager API
// ============================================================================
function wireHoldAgent(manager: GameManager, power: Power): void {
  manager.onPhaseChange(async (_phase, state) => {
    // Yield to macrotask so collectOrders/collectRetreats/collectBuilds can set up gates first
    await new Promise<void>((r) => setTimeout(r, 0));
    if (state.phase.type === PhaseType.Orders) {
      const orders: Order[] = state.units
        .filter((u) => u.power === power)
        .map((u) => ({ type: OrderType.Hold as const, unit: u.province }));
      manager.submitOrders(power, orders);
    } else if (state.phase.type === PhaseType.Retreats) {
      const retreats = state.retreatSituations
        .filter((s) => s.unit.power === power)
        .map((s) => ({ type: 'Disband' as const, unit: s.unit.province }));
      manager.submitRetreats(power, retreats);
    } else if (state.phase.type === PhaseType.Builds) {
      const buildCount = manager.getBuildCount(power);
      if (buildCount > 0) {
        const builds: BuildOrder[] = Array.from({ length: buildCount }, () => ({
          type: 'Waive' as const,
        }));
        manager.submitBuilds(power, builds);
      } else if (buildCount < 0) {
        const myUnits = state.units.filter((u) => u.power === power);
        const builds: BuildOrder[] = myUnits
          .slice(0, Math.abs(buildCount))
          .map((u) => ({ type: 'Remove' as const, unit: u.province }));
        manager.submitBuilds(power, builds);
      } else {
        manager.submitBuilds(power, []);
      }
    }
  });
}

function connectAllHold(manager: GameManager): void {
  for (const power of ALL_POWERS) {
    wireHoldAgent(manager, power);
  }
}

// ============================================================================
// 1. INITIALIZATION
// ============================================================================

describe('GameManager — Initialization', () => {
  it('starts with correct initial state', () => {
    const manager = new GameManager();
    const state = manager.getState();

    expect(state.phase.year).toBe(1901);
    expect(state.phase.season).toBe(Season.Spring);
    expect(state.phase.type).toBe(PhaseType.Orders);
    expect(state.units).toHaveLength(22);
    expect(state.supplyCenters.size).toBe(22);
    expect(state.endYear).toBeUndefined();
  });
});

// ============================================================================
// 2. ALL-HOLD GAME — deterministic behavior
// ============================================================================

describe('GameManager — All-Hold game', () => {
  it('completes one full year with all units holding', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    const events: GameEvent[] = [];
    manager.onEvent((e) => events.push(e));

    const result = await manager.run();

    // With all holds, no one captures supply centers => draw after 1 year
    expect(result.winner).toBeNull();
    expect(result.year).toBe(1902); // advances past 1901

    // Check that all units are still in starting positions
    const state = manager.getState();
    expect(state.units).toHaveLength(22);
    for (const startUnit of STARTING_UNITS) {
      const found = state.units.find(
        (u) =>
          u.province === startUnit.province &&
          u.power === startUnit.power &&
          u.type === startUnit.type,
      );
      expect(found, `${startUnit.power} ${startUnit.type} at ${startUnit.province}`).toBeDefined();
    }
  });

  it('emits correct event sequence for one year', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    const eventTypes: string[] = [];
    manager.onEvent((e) => eventTypes.push(e.type));

    await manager.run();

    // Expected sequence: game_start, spring orders, fall orders, winter builds
    expect(eventTypes[0]).toBe('game_start');
    expect(eventTypes).toContain('phase_start');
    expect(eventTypes).toContain('orders_resolved');
    expect(eventTypes).toContain('builds_resolved');
  });

  it('supply centers unchanged after all-hold game', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);
    await manager.run();

    const state = manager.getState();
    // No neutral SCs captured, all home SCs retained
    expect(state.supplyCenters.size).toBe(22);
  });

  it('turn history is recorded', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);
    await manager.run();

    const history = manager.getTurnHistory();
    // At minimum: spring orders, fall orders, winter builds
    expect(history.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// 3. EVENT SYSTEM
// ============================================================================

describe('GameManager — Event system', () => {
  it('game_start event fires first', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    let firstEvent: GameEvent | null = null;
    manager.onEvent((e) => {
      if (!firstEvent) firstEvent = e;
    });

    await manager.run();

    expect(firstEvent).not.toBeNull();
    expect(firstEvent!.type).toBe('game_start');
  });

  it('multiple listeners all receive events', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    let count1 = 0;
    let count2 = 0;
    manager.onEvent(() => count1++);
    manager.onEvent(() => count2++);

    await manager.run();

    expect(count1).toBeGreaterThan(0);
    expect(count1).toBe(count2);
  });

  it('orders_resolved events include resolutions', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    const orderEvents: GameEvent[] = [];
    manager.onEvent((e) => {
      if (e.type === 'orders_resolved') orderEvents.push(e);
    });

    await manager.run();

    expect(orderEvents.length).toBe(2); // spring + fall
    for (const event of orderEvents) {
      expect(event.turnRecord).toBeDefined();
      expect(event.turnRecord!.orders).toBeDefined();
      expect(event.turnRecord!.orders!.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================================
// 5. BUILD PHASE
// ============================================================================

describe('GameManager — Build phase', () => {
  it('HoldAgent waives all builds (no new units built)', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);
    await manager.run();

    // All hold => no one captures SCs => no builds/removals needed
    // Unit count should stay at 22
    expect(manager.getState().units).toHaveLength(22);
  });

  it('build events are emitted in winter', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    const buildEvents: GameEvent[] = [];
    manager.onEvent((e) => {
      if (e.type === 'builds_resolved') buildEvents.push(e);
    });

    await manager.run();

    expect(buildEvents).toHaveLength(1);
    expect(buildEvents[0].phase.type).toBe(PhaseType.Builds);
  });
});

// ============================================================================
// 6. VICTORY DETECTION
// ============================================================================

describe('GameManager — Victory detection', () => {
  it('detects victory when a power reaches 18 supply centers', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    // Hack the supply centers to give England 18
    const state = manager.getState();
    const neutralSCs = [
      'nor',
      'swe',
      'den',
      'hol',
      'bel',
      'spa',
      'por',
      'tun',
      'ser',
      'rum',
      'bul',
      'gre',
      'naf',
      'alb',
      'mun',
    ];
    for (const sc of neutralSCs) {
      state.supplyCenters.set(sc, Power.England);
    }

    const result = await manager.run();

    // England should have 18+ SCs and win
    expect(result.winner).toBe(Power.England);
  });

  it('draw when max years reached with no winner', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    const result = await manager.run();

    expect(result.winner).toBeNull();
  });
});

// ============================================================================
// 7. CONFIG OBJECT — startYear and victoryThreshold
// ============================================================================

describe('GameManager — Config object', () => {
  it('default startYear is 1901', () => {
    const manager = new GameManager();
    const state = manager.getState();
    expect(state.phase.year).toBe(1901);
  });

  it('custom startYear is accepted', () => {
    const manager = new GameManager({ startYear: 2000 });
    const state = manager.getState();
    expect(state.phase.year).toBe(2000);
  });

  it('endYear = startYear - 1 + maxYears', () => {
    const manager = new GameManager({ startYear: 2000, maxYears: 10 });
    const state = manager.getState();
    expect(state.endYear).toBe(2009);
  });

  it('custom victoryThreshold is accepted', async () => {
    // With threshold of 4, England starts with 3 SCs. Give it 1 more to win.
    const manager = new GameManager({ maxYears: 1, victoryThreshold: 4 });
    connectAllHold(manager);

    const state = manager.getState();
    state.supplyCenters.set('nor', Power.England);

    const result = await manager.run();
    expect(result.winner).toBe(Power.England);
  });
});

// ============================================================================
// 8. FAST ADJUDICATION
// ============================================================================

describe('GameManager — Fast adjudication', () => {
  it('getGameConfig includes fastAdjudication', () => {
    const manager = new GameManager();
    expect(manager.getGameConfig().fastAdjudication).toBe(true);

    const manager2 = new GameManager({ fastAdjudication: false });
    expect(manager2.getGameConfig().fastAdjudication).toBe(false);
  });
});

// ============================================================================
// 9. DRAW VOTING
// ============================================================================

describe('GameManager — Draw voting', () => {
  it('draw proposal by all active powers ends the game', async () => {
    const manager = new GameManager({ maxYears: 50 });
    connectAllHold(manager);

    manager.onPhaseChange((phase) => {
      if (phase.type === PhaseType.Orders) {
        for (const power of manager.getActivePowers()) {
          manager.proposeDraw(power);
        }
      }
    });

    const result = await manager.run();
    expect(result.winner).toBeNull();
    expect(result.year).toBe(1901);
  });

  it('partial draw votes do not end the game', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    manager.onPhaseChange((phase) => {
      if (phase.type === PhaseType.Orders) {
        manager.proposeDraw(Power.England);
      }
    });

    const result = await manager.run();
    expect(result.winner).toBeNull();
  });

  it('draw votes reset each season', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    let phaseCount = 0;
    manager.onPhaseChange((phase) => {
      if (phase.type === PhaseType.Orders) {
        phaseCount++;
        if (phaseCount === 1) {
          manager.proposeDraw(Power.England);
          manager.proposeDraw(Power.France);
        }
      }
    });

    const result = await manager.run();
    expect(result.winner).toBeNull();
  });

  it('allowDraws=false rejects draw proposals', async () => {
    const manager = new GameManager({ maxYears: 1, allowDraws: false });
    connectAllHold(manager);

    manager.onPhaseChange((phase) => {
      if (phase.type === PhaseType.Orders) {
        for (const power of manager.getActivePowers()) {
          manager.proposeDraw(power);
        }
      }
    });

    const result = await manager.run();
    expect(result.winner).toBeNull();
  });

  it('proposeDraw returns true when accepted, false when rejected', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);

    let accepted: boolean | undefined;
    manager.onPhaseChange((phase) => {
      if (phase.type === PhaseType.Orders) {
        accepted = manager.proposeDraw(Power.England);
      }
    });

    const managerNoDraws = new GameManager({ maxYears: 1, allowDraws: false });
    connectAllHold(managerNoDraws);

    let rejected: boolean | undefined;
    managerNoDraws.onPhaseChange((phase) => {
      if (phase.type === PhaseType.Orders) {
        rejected = managerNoDraws.proposeDraw(Power.England);
      }
    });

    await manager.run();
    await managerNoDraws.run();

    expect(accepted).toBe(true);
    expect(rejected).toBe(false);
  });
});

// ============================================================================
// 10. CONCESSION
// ============================================================================

describe('GameManager — Concession', () => {
  it('concede returns true for an active power', () => {
    const manager = new GameManager();
    expect(manager.concede(Power.England)).toBe(true);
  });

  it('concede returns false for an already-conceded power', () => {
    const manager = new GameManager();
    manager.concede(Power.England);
    expect(manager.concede(Power.England)).toBe(false);
  });

  it('concede returns false for an eliminated power', async () => {
    const manager = new GameManager({ maxYears: 1 });
    // Remove all England units to simulate elimination
    const state = manager.getState();
    state.units = state.units.filter((u) => u.power !== Power.England);
    expect(manager.concede(Power.England)).toBe(false);
  });

  it('getActivePowers excludes conceded powers', () => {
    const manager = new GameManager();
    expect(manager.getActivePowers()).toContain(Power.England);
    manager.concede(Power.England);
    expect(manager.getActivePowers()).not.toContain(Power.England);
  });

  it('getConcededPowers tracks conceded powers', () => {
    const manager = new GameManager();
    expect(manager.getConcededPowers()).toEqual([]);
    manager.concede(Power.England);
    expect(manager.getConcededPowers()).toEqual([Power.England]);
  });

  it('conceded power is excluded from GameResult.eliminatedPowers', async () => {
    const manager = new GameManager({ maxYears: 1 });
    connectAllHold(manager);
    manager.concede(Power.England);

    const result = await manager.run();
    expect(result.concededPowers).toContain(Power.England);
    expect(result.eliminatedPowers).not.toContain(Power.England);
  });

  it('conceded power is skipped in gate collection', async () => {
    const manager = new GameManager({ maxYears: 1 });
    // Wire agents for all powers except England
    for (const power of ALL_POWERS) {
      if (power !== Power.England) {
        wireHoldAgent(manager, power);
      }
    }
    // Concede England — getActivePowers() excludes it, so no gate is created
    manager.concede(Power.England);

    const result = await manager.run();

    expect(result).toBeDefined();
    expect(result.concededPowers).toContain(Power.England);
    // England's units should still exist (they hold, nobody attacks in all-hold)
    const englandUnits = manager.getState().units.filter((u) => u.power === Power.England);
    expect(englandUnits.length).toBeGreaterThan(0);
  });

  it('draw vote counting excludes conceded powers', async () => {
    const manager = new GameManager({ maxYears: 50 });
    connectAllHold(manager);

    // Concede England first
    manager.concede(Power.England);

    // All remaining active powers propose a draw
    manager.onPhaseChange((phase) => {
      if (phase.type === PhaseType.Orders) {
        for (const power of manager.getActivePowers()) {
          manager.proposeDraw(power);
        }
      }
    });

    const result = await manager.run();
    // Draw should succeed without England's vote
    expect(result.winner).toBeNull();
    expect(result.year).toBe(1901);
    expect(result.concededPowers).toContain(Power.England);
  });

  it('broadcasts a global message when a power concedes', () => {
    const manager = new GameManager();
    const messages: { content: string }[] = [];
    manager.onMessage((msg) => messages.push(msg));

    manager.concede(Power.France);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('France has conceded.');
  });
});
