import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhaseType, Power, Season, UnitType } from '../engine/types';
import { generateRandomBuilds, generateRandomOrders, generateRandomRetreats } from './random-agent';

// Stub Math.random to always return 0 → deterministic "first element" picks
beforeEach(() => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateRandomOrders', () => {
  it('produces exactly one order per own unit', () => {
    const state = {
      phase: { season: Season.Spring, year: 1901, type: PhaseType.Orders },
      units: [
        { type: UnitType.Fleet, power: Power.England, province: 'lon' },
        { type: UnitType.Army, power: Power.England, province: 'lvp' },
        { type: UnitType.Army, power: Power.France, province: 'par' },
      ],
      supplyCenters: new Map([
        ['lon', Power.England],
        ['lvp', Power.England],
        ['par', Power.France],
      ]),
      orderHistory: [],
      retreatSituations: [],
      endYear: 1910,
    };

    const orders = generateRandomOrders(state, Power.England);

    expect(orders).toHaveLength(2);
    for (const o of orders) {
      expect(['Hold', 'Move', 'Support', 'Convoy']).toContain(o.type);
    }
  });

  it('returns Hold for a unit with no province data', () => {
    const state = {
      phase: { season: Season.Spring, year: 1901, type: PhaseType.Orders },
      units: [{ type: UnitType.Army, power: Power.England, province: 'fake_province' }],
      supplyCenters: new Map<string, Power>(),
      orderHistory: [],
      retreatSituations: [],
      endYear: 1910,
    };

    const orders = generateRandomOrders(state, Power.England);

    expect(orders).toEqual([{ type: 'Hold', unit: 'fake_province' }]);
  });

  it('ignores units belonging to other powers', () => {
    const state = {
      phase: { season: Season.Spring, year: 1901, type: PhaseType.Orders },
      units: [
        { type: UnitType.Army, power: Power.France, province: 'par' },
        { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      ],
      supplyCenters: new Map<string, Power>(),
      orderHistory: [],
      retreatSituations: [],
      endYear: 1910,
    };

    const orders = generateRandomOrders(state, Power.England);

    expect(orders).toHaveLength(0);
  });
});

describe('generateRandomRetreats', () => {
  it('produces a RetreatMove when valid destinations exist', () => {
    const state = {
      phase: { season: Season.Fall, year: 1901, type: PhaseType.Retreats },
      units: [],
      supplyCenters: new Map<string, Power>(),
      orderHistory: [],
      retreatSituations: [
        {
          unit: { type: UnitType.Army, power: Power.England, province: 'lon' },
          attackedFrom: 'wal',
          validDestinations: ['yor'],
        },
      ],
      endYear: 1910,
    };

    const retreats = generateRandomRetreats(state, Power.England);

    expect(retreats).toEqual([
      { type: 'RetreatMove', unit: 'lon', destination: 'yor', coast: undefined },
    ]);
  });

  it('produces a Disband when no valid destinations', () => {
    const state = {
      phase: { season: Season.Fall, year: 1901, type: PhaseType.Retreats },
      units: [],
      supplyCenters: new Map<string, Power>(),
      orderHistory: [],
      retreatSituations: [
        {
          unit: { type: UnitType.Army, power: Power.England, province: 'lon' },
          attackedFrom: 'wal',
          validDestinations: [],
        },
      ],
      endYear: 1910,
    };

    const retreats = generateRandomRetreats(state, Power.England);

    expect(retreats).toEqual([{ type: 'Disband', unit: 'lon' }]);
  });

  it('ignores retreat situations for other powers', () => {
    const state = {
      phase: { season: Season.Fall, year: 1901, type: PhaseType.Retreats },
      units: [],
      supplyCenters: new Map<string, Power>(),
      orderHistory: [],
      retreatSituations: [
        {
          unit: { type: UnitType.Army, power: Power.France, province: 'par' },
          attackedFrom: 'bur',
          validDestinations: ['pic'],
        },
      ],
      endYear: 1910,
    };

    const retreats = generateRandomRetreats(state, Power.England);

    expect(retreats).toHaveLength(0);
  });
});

describe('generateRandomBuilds', () => {
  it('builds units on available home centers for positive buildCount', () => {
    const state = {
      phase: { season: Season.Fall, year: 1901, type: PhaseType.Builds },
      units: [],
      supplyCenters: new Map([
        ['lon', Power.England],
        ['edi', Power.England],
        ['lvp', Power.England],
      ]),
      orderHistory: [],
      retreatSituations: [],
      endYear: 1910,
    };

    const builds = generateRandomBuilds(state, Power.England, 2);

    expect(builds).toHaveLength(2);
    for (const b of builds) {
      expect(b.type).toBe('Build');
    }
  });

  it('waives when no home centers are available', () => {
    const state = {
      phase: { season: Season.Fall, year: 1901, type: PhaseType.Builds },
      units: [
        { type: UnitType.Fleet, power: Power.England, province: 'lon' },
        { type: UnitType.Fleet, power: Power.England, province: 'edi' },
        { type: UnitType.Army, power: Power.England, province: 'lvp' },
      ],
      supplyCenters: new Map([
        ['lon', Power.England],
        ['edi', Power.England],
        ['lvp', Power.England],
        ['nwy', Power.England],
      ]),
      orderHistory: [],
      retreatSituations: [],
      endYear: 1910,
    };

    const builds = generateRandomBuilds(state, Power.England, 1);

    expect(builds).toEqual([{ type: 'Waive' }]);
  });

  it('removes units for negative buildCount', () => {
    const state = {
      phase: { season: Season.Fall, year: 1901, type: PhaseType.Builds },
      units: [
        { type: UnitType.Army, power: Power.England, province: 'lon' },
        { type: UnitType.Fleet, power: Power.England, province: 'nth' },
      ],
      supplyCenters: new Map([['lon', Power.England]]),
      orderHistory: [],
      retreatSituations: [],
      endYear: 1910,
    };

    const builds = generateRandomBuilds(state, Power.England, -1);

    expect(builds).toHaveLength(1);
    expect(builds[0].type).toBe('Remove');
  });

  it('returns empty array for zero buildCount', () => {
    const state = {
      phase: { season: Season.Fall, year: 1901, type: PhaseType.Builds },
      units: [],
      supplyCenters: new Map<string, Power>(),
      orderHistory: [],
      retreatSituations: [],
      endYear: 1910,
    };

    const builds = generateRandomBuilds(state, Power.England, 0);

    expect(builds).toHaveLength(0);
  });
});
