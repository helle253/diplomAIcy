import { describe, expect, it } from 'vitest';

import { PROVINCES, STARTING_SUPPLY_CENTERS, STARTING_UNITS } from './map.js';
import { buildMapState } from './map-state.js';
import { Coast, Power, ProvinceType, UnitType } from './types.js';

describe('buildMapState', () => {
  const map = buildMapState(STARTING_UNITS, STARTING_SUPPLY_CENTERS);

  it('returns all 75 provinces', () => {
    expect(Object.keys(map).length).toBe(Object.keys(PROVINCES).length);
  });

  it('includes static topology for a land province', () => {
    const mun = map['mun'];
    expect(mun.type).toBe(ProvinceType.Land);
    expect(mun.supplyCenter).toBe(true);
    expect(mun.homeCenter).toBe(Power.Germany);
    expect(mun.adjacent).toContain('bur');
    expect(mun.adjacent).toContain('ruh');
    expect(mun.coasts).toBeNull();
  });

  it('includes static topology for a sea province', () => {
    const mao = map['mao'];
    expect(mao.type).toBe(ProvinceType.Sea);
    expect(mao.supplyCenter).toBe(false);
    expect(mao.homeCenter).toBeNull();
    expect(mao.unit).toBeNull();
    expect(mao.owner).toBeNull();
  });

  it('computes union adjacency for multi-coast provinces', () => {
    const spa = map['spa'];
    expect(spa.adjacent).toContain('por');
    expect(spa.adjacent).toContain('gas');
    expect(spa.adjacent).toContain('mar');
    expect(spa.adjacent).toContain('mao');
    expect(spa.adjacent).toContain('lyo');
    expect(spa.adjacent).toContain('wes');
    expect(new Set(spa.adjacent).size).toBe(spa.adjacent.length);
  });

  it('includes coast-specific adjacency for multi-coast provinces', () => {
    const spa = map['spa'];
    expect(spa.coasts).not.toBeNull();
    expect(spa.coasts!['nc']).toContain('por');
    expect(spa.coasts!['nc']).toContain('gas');
    expect(spa.coasts!['nc']).toContain('mao');
    expect(spa.coasts!['sc']).toContain('mar');
    expect(spa.coasts!['sc']).toContain('lyo');
  });

  it('includes unit data at starting positions', () => {
    const mun = map['mun'];
    expect(mun.unit).toEqual({ type: UnitType.Army, power: Power.Germany, coast: null });
  });

  it('includes fleet with coast data', () => {
    const stp = map['stp'];
    expect(stp.unit).toEqual({ type: UnitType.Fleet, power: Power.Russia, coast: Coast.South });
  });

  it('includes supply center ownership', () => {
    expect(map['mun'].owner).toBe(Power.Germany);
    expect(map['bel'].supplyCenter).toBe(true);
    expect(map['bel'].owner).toBeNull();
  });

  it('shows null unit for empty provinces', () => {
    expect(map['bur'].unit).toBeNull();
  });
});
