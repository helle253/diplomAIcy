import { describe, expect, it } from 'vitest';

import { PhaseType, Power, Season, UnitType } from '../engine/types';
import { generateRandomBuilds, generateRandomOrders, generateRandomRetreats } from './random-agent';

describe('Random agent order generation', () => {
  it('generates one order per unit', () => {
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
    expect(orders).toHaveLength(2); // Only England's units
    for (const o of orders) {
      expect(['Hold', 'Move', 'Support', 'Convoy']).toContain(o.type);
    }
  });

  it('generates retreats for dislodged units', () => {
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
    expect(retreats).toHaveLength(1);
    expect(['RetreatMove', 'Disband']).toContain(retreats[0].type);
  });

  it('generates build orders for positive build count', () => {
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
    expect(builds.length).toBeGreaterThan(0);
    expect(builds.length).toBeLessThanOrEqual(2);
    for (const b of builds) {
      expect(['Build', 'Waive']).toContain(b.type);
    }
  });

  it('generates remove orders for negative build count', () => {
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

  it('returns empty array for zero build count', () => {
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

  it('returns disband when no valid retreat destinations', () => {
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
    expect(retreats).toHaveLength(1);
    expect(retreats[0].type).toBe('Disband');
  });
});
