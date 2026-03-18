import { describe, expect, it } from 'vitest';

import { GameState, PhaseType, Power, Season, UnitType } from '../../engine/types';
import { buildStrategicSummary, extractPlanBlock } from './prompts';

function makeState(overrides: Partial<GameState> = {}): GameState {
  const supplyCenters = new Map<string, Power>([
    ['lon', Power.England],
    ['edi', Power.England],
    ['lvp', Power.England],
    ['par', Power.France],
    ['bre', Power.France],
    ['mar', Power.France],
    ['ber', Power.Germany],
    ['mun', Power.Germany],
    ['kie', Power.Germany],
    ['rom', Power.Italy],
    ['nap', Power.Italy],
    ['ven', Power.Italy],
    ['vie', Power.Austria],
    ['bud', Power.Austria],
    ['tri', Power.Austria],
    ['mos', Power.Russia],
    ['war', Power.Russia],
    ['stp', Power.Russia],
    ['sev', Power.Russia],
    ['con', Power.Turkey],
    ['ank', Power.Turkey],
    ['smy', Power.Turkey],
  ]);
  return {
    phase: { year: 1901, season: Season.Spring, type: PhaseType.Orders },
    units: [
      { power: Power.England, type: UnitType.Army, province: 'lon', coast: undefined },
      { power: Power.England, type: UnitType.Fleet, province: 'edi', coast: undefined },
      { power: Power.England, type: UnitType.Fleet, province: 'lvp', coast: undefined },
      { power: Power.France, type: UnitType.Army, province: 'par', coast: undefined },
      { power: Power.France, type: UnitType.Army, province: 'mar', coast: undefined },
      { power: Power.France, type: UnitType.Fleet, province: 'bre', coast: undefined },
    ],
    supplyCenters,
    orderHistory: [],
    retreatSituations: [],
    ...overrides,
  };
}

describe('buildStrategicSummary', () => {
  it('shows power rankings sorted by SC count', () => {
    const state = makeState();
    const summary = buildStrategicSummary(state, Power.England);
    expect(summary).toContain('Russia: 4 SCs');
    expect(summary).toContain('England: 3 SCs');
    // Russia should appear before England (more SCs)
    expect(summary.indexOf('Russia')).toBeLessThan(summary.indexOf('England'));
  });

  it('shows trend arrows for SC changes', () => {
    const supplyCenters = new Map<string, Power>([
      ['lon', Power.England],
      ['edi', Power.England],
      ['lvp', Power.England],
      ['bel', Power.England],
    ]);
    const state = makeState({ supplyCenters });
    const summary = buildStrategicSummary(state, Power.England);
    expect(summary).toMatch(/England.*\+1/);
  });

  it('lists neutral supply centers', () => {
    const state = makeState();
    const summary = buildStrategicSummary(state, Power.England);
    expect(summary).toContain('NEUTRAL SUPPLY CENTERS');
    expect(summary).toContain('bel');
    expect(summary).toContain('hol');
    expect(summary).toContain('den');
    expect(summary).not.toMatch(/NEUTRAL.*lon/);
  });

  it('identifies neighboring enemy units', () => {
    const state = makeState({
      units: [
        { power: Power.England, type: UnitType.Fleet, province: 'lon', coast: undefined },
        { power: Power.France, type: UnitType.Fleet, province: 'eng', coast: undefined },
      ],
    });
    const summary = buildStrategicSummary(state, Power.England);
    expect(summary).toContain('France');
    expect(summary).toContain('eng');
  });

  it('shows lost home centers', () => {
    const supplyCenters = new Map<string, Power>([
      ['lon', Power.England],
      ['edi', Power.England],
      ['lvp', Power.France],
    ]);
    const state = makeState({
      supplyCenters,
      units: [
        { power: Power.England, type: UnitType.Fleet, province: 'lon', coast: undefined },
        { power: Power.England, type: UnitType.Fleet, province: 'edi', coast: undefined },
      ],
    });
    const summary = buildStrategicSummary(state, Power.England);
    expect(summary).toContain('lvp');
    expect(summary).toMatch(/lost/i);
  });
});

describe('extractPlanBlock', () => {
  it('extracts plan from response with plan fence', () => {
    const response =
      'I will attack.\n\n```plan\nGOAL: Take Belgium\nALLIES: France\nENEMIES: Germany\nNEXT: A yor → bel\n```\n\nDone.';
    const result = extractPlanBlock(response);
    expect(result.plan).toContain('GOAL: Take Belgium');
    expect(result.plan).toContain('ALLIES: France');
    expect(result.cleaned).not.toContain('```plan');
    expect(result.cleaned).toContain('I will attack.');
  });

  it('returns null plan when no plan block', () => {
    const response = 'Just some text with no plan.';
    const result = extractPlanBlock(response);
    expect(result.plan).toBeNull();
    expect(result.cleaned).toBe(response);
  });

  it('handles plan block with extra whitespace', () => {
    const response = '```plan  \n  GOAL: Hold  \n```';
    const result = extractPlanBlock(response);
    expect(result.plan).toContain('GOAL: Hold');
  });
});
