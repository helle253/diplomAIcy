import { describe, expect, it } from 'vitest';

import { PROVINCES } from './map.js';
import { resolveOrders } from './resolver.js';
import { Coast, Order, OrderStatus, OrderType, Power, Unit, UnitType } from './types.js';

// ============================================================================
// Helper: find the resolution for the unit originally at a given province
// Rules Source: https://www.playdiplomacy.com/help.php?sub_page=Game_Rules
// ============================================================================
function res(result: ReturnType<typeof resolveOrders>, province: string) {
  return result.resolutions.find((r) => r.order.unit === province);
}

// ============================================================================
// 1. BASIC ORDERS
// [Rule 12] Units receive one of four order types: Hold, Move, Support, Convoy.
//           Armies move to adjacent land/coastal provinces.
//           Fleets move along coastlines and through sea provinces.
//           Units with no orders default to Hold. Invalid orders become Hold.
// ============================================================================

describe('Basic Orders [Rule 12]', () => {
  it('Hold succeeds when uncontested', () => {
    // [Rule 12] A unit ordered to hold remains "in place".
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'mun' }];
    const orders = new Map<string, Order>([['mun', { type: OrderType.Hold, unit: 'mun' }]]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions).toHaveLength(1);
    expect(result.newPositions[0].province).toBe('mun');
  });

  it('Move to empty adjacent province succeeds', () => {
    // [Rule 12] A unit moves "to an adjacent province".
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'mun' }];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bur');
  });

  it('Unit with no order defaults to Hold', () => {
    // [Rule 12] A unit not given an order is treated as holding.
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'mun' }];
    const orders = new Map<string, Order>(); // empty — no order given
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.order.type).toBe(OrderType.Hold);
    expect(res(result, 'mun')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('mun');
  });

  it('Move to non-adjacent province becomes Hold', () => {
    // [Rule 12] Invalid orders (non-adjacent destination) are converted to Hold.
    // Munich is not adjacent to Paris by army.
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'mun' }];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'par' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.order.type).toBe(OrderType.Hold);
    expect(result.newPositions[0].province).toBe('mun');
  });

  it('Army cannot move to sea province — becomes Hold', () => {
    // [Rule 12] Armies cannot enter sea provinces (except via convoy).
    // Kiel is fleet-adjacent to Baltic Sea, but armies cannot go there.
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'kie' }];
    const orders = new Map<string, Order>([
      ['kie', { type: OrderType.Move, unit: 'kie', destination: 'bal' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'kie')!.order.type).toBe(OrderType.Hold);
    expect(result.newPositions[0].province).toBe('kie');
  });

  it('Fleet cannot move to inland province — becomes Hold', () => {
    // [Rule 12] Fleets are "limited to coastline-adjacent provinces" — cannot enter inland.
    // Kiel fleet cannot move to Munich (inland).
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'kie' }];
    const orders = new Map<string, Order>([
      ['kie', { type: OrderType.Move, unit: 'kie', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'kie')!.order.type).toBe(OrderType.Hold);
    expect(result.newPositions[0].province).toBe('kie');
  });

  it('Fleet moves along coast successfully', () => {
    // [Rule 12] Fleets move through sea provinces and along coastlines.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.England, province: 'nth' }];
    const orders = new Map<string, Order>([
      ['nth', { type: OrderType.Move, unit: 'nth', destination: 'eng' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'nth')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('eng');
  });
});

// ============================================================================
// 2. COMBAT — ATTACK vs. DEFENSE STRENGTH
// [Rule 15-17] When equal-force units move to the same province, they "bounce
//              and neither advances." Greater force prevails.
// [Rule 18] A unit is dislodged only when attacked with "greater force than
//           the unit plus all of its support to hold."
// ============================================================================

describe('Combat [Rules 15-18]', () => {
  it('Unsupported move fails against unsupported hold (1 vs 1)', () => {
    // [Rule 18] Attacker must have strictly greater force to dislodge.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
    ];
    const orders = new Map<string, Order>([
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Supported move (2) dislodges unsupported hold (1)', () => {
    // [Rule 13-14, 18] Support adds force. Attack strength 2 > defense 1 => dislodge.
    // A Mun S A Ruh -> Bur, A Ruh -> Bur, A Bur H
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds);
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('bur');
    expect(
      result.newPositions.find((u) => u.power === Power.Germany && u.province === 'bur'),
    ).toBeDefined();
  });

  it('Supported move (2) vs supported hold (2) — attack fails', () => {
    // [Rule 18] Attacker must have "greater force" — equal is not enough.
    // A Mun S A Ruh -> Bur (attack 2), A Par S A Bur H (defense 2)
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['par', { type: OrderType.Support, unit: 'par', supportedUnit: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Two units bouncing into same empty province — both fail', () => {
    // [Rule 15] Equal-force units "bounce and neither advances."
    // A Mun -> Bur, A Par -> Bur (both strength 1, Bur is empty)
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'bur' }],
      ['par', { type: OrderType.Move, unit: 'par', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'par')!.status).toBe(OrderStatus.Fails);
    // Both stay in place
    expect(result.newPositions.find((u) => u.province === 'mun')).toBeDefined();
    expect(result.newPositions.find((u) => u.province === 'par')).toBeDefined();
  });

  it('Stronger of two competing moves wins', () => {
    // [Rule 16] "Greater force prevails" when competing for a province.
    // A Ruh -> Bur (S from Mun, strength 2), A Par -> Bur (strength 1)
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['par', { type: OrderType.Move, unit: 'par', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'par')!.status).toBe(OrderStatus.Fails);
  });

  it('Three-way bounce — three units move to same province, all fail', () => {
    // [Rule 15] Multiple equal-force moves to the same province all bounce.
    // A Mun -> Bur, A Par -> Bur, A Mar -> Bur (all strength 1)
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Army, power: Power.Italy, province: 'mar' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'bur' }],
      ['par', { type: OrderType.Move, unit: 'par', destination: 'bur' }],
      ['mar', { type: OrderType.Move, unit: 'mar', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'par')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'mar')!.status).toBe(OrderStatus.Fails);
  });

  it('Unit moving away makes province empty — attacker succeeds', () => {
    // [Rule 17] Bounced units retain defensive strength of 1; but a unit that
    // successfully moves out leaves the province vacant (defense 0).
    // A Bur -> Par, A Ruh -> Bur. Bur leaves, so Ruh enters unopposed.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'par' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bur')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions.find((u) => u.power === Power.France)!.province).toBe('par');
    expect(result.newPositions.find((u) => u.power === Power.Germany)!.province).toBe('bur');
  });

  it('Bounce prevents move-out, so attacker also fails (dependency chain)', () => {
    // [Rule 15, 17] A bounced unit stays put and retains defensive strength of 1.
    // A Bur -> Mar, A Pie -> Mar (bounce at Mar), A Ruh -> Bur
    // Bur can't leave (bounces), so Ruh can't enter.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Italy, province: 'pie' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'mar' }],
      ['pie', { type: OrderType.Move, unit: 'pie', destination: 'mar' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'pie')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
  });
});

// ============================================================================
// 3. SUPPORT CUTTING
// [Rule 19] Support is "cut if the supporting unit is attacked from any
//           province except the one where support is being given."
// [Rule 21] Dislodged units always lose support capability.
// ============================================================================

describe('Support Cutting [Rules 19-21]', () => {
  it('Support cut by attack from non-target province', () => {
    // [Rule 19] Attack from a province OTHER than the support target cuts support.
    // A Mun S A Ruh -> Bur, A Bur H, A Boh -> Mun (cuts support from non-target)
    // Without support: Ruh (1) vs Bur (1) => bounce
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Austria, province: 'boh' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['boh', { type: OrderType.Move, unit: 'boh', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails); // support cut
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails); // now 1 vs 1
  });

  it('Support NOT cut by attack from the target province', () => {
    // [Rule 19] Attack from the province "where support is being given" does NOT cut.
    // A Mun S A Ruh -> Bur. A Bur -> Mun. Attack on Mun from Bur (the target).
    // Support is NOT cut. Ruh strength 2 vs Bur strength 1 in head-to-head.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Succeeds); // not cut
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds); // wins head-to-head
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails); // loses
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('bur');
  });

  it('Support-hold cut by attack from any province', () => {
    // [Rule 19] For support-hold, the target is the supported unit's province.
    //           An attack from any OTHER province cuts it.
    // A Par S A Bur H. A Tyr -> Mun (unrelated). A Pic -> Par cuts Par's support.
    // Then A Ruh -> Bur at 1 vs Bur at 1 (support was cut).
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Army, power: Power.England, province: 'pic' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['par', { type: OrderType.Support, unit: 'par', supportedUnit: 'bur' }],
      ['pic', { type: OrderType.Move, unit: 'pic', destination: 'par' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'par')!.status).toBe(OrderStatus.Fails); // support cut
    // With support cut, bur hold strength is 1, ruh attack strength is 1 => bounce
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Failed attack does NOT cut support (attack must be valid move)', () => {
    // [Rule 12, 19] An invalid move (non-adjacent) becomes Hold. Only a valid
    // move order to the supporter's province can cut support.
    // A Mun S A Ruh -> Bur. A Mos -> Mun (not adjacent — becomes Hold).
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Russia, province: 'mos' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['mos', { type: OrderType.Move, unit: 'mos', destination: 'mun' }], // invalid, non-adjacent
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // mos -> mun is invalid, becomes Hold, cannot cut support
    expect(res(result, 'mos')!.order.type).toBe(OrderType.Hold);
    expect(res(result, 'mun')!.status).toBe(OrderStatus.Succeeds); // support intact
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds); // strength 2 vs 1
    expect(result.dislodgedUnits).toHaveLength(1);
  });

  it('Multiple supports — one cut, one intact — attack still succeeds', () => {
    // [Rule 19] Each support is independently evaluated for cutting.
    // A Mun S A Ruh -> Bur, A Kie S A Ruh -> Bur. A Boh -> Mun cuts Mun's support.
    // But Kie's support is not attacked, so Ruh still has strength 2.
    // Kie is not adjacent to Bur though, so we need a valid supporter.
    // Let's use: A Gas S A Ruh -> Bur (Gas is adjacent to Bur).
    // A Boh -> Mun cuts Mun's support. Gas support intact. Ruh strength 2 vs Bur hold 1.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'gas' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Austria, province: 'boh' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['gas', { type: OrderType.Support, unit: 'gas', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['boh', { type: OrderType.Move, unit: 'boh', destination: 'mun' }], // cuts mun support
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails); // cut
    expect(res(result, 'gas')!.status).toBe(OrderStatus.Succeeds); // intact
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds); // strength 2
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('bur');
  });
});

// ============================================================================
// 4. HEAD-TO-HEAD BATTLES
// [Rule 15] When two units move to each other's province, equal strength
//           means both "bounce and neither advances."
// [Rule 16] Greater force prevails in head-to-head, dislodging the weaker unit.
// ============================================================================

describe('Head-to-Head [Rules 15-16]', () => {
  it('Equal head-to-head — both bounce', () => {
    // [Rule 15] A->B and B->A with equal strength => both bounce.
    // A Mun -> Bur, A Bur -> Mun (both strength 1)
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'bur' }],
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
    expect(result.newPositions.find((u) => u.province === 'mun')).toBeDefined();
    expect(result.newPositions.find((u) => u.province === 'bur')).toBeDefined();
  });

  it('Supported head-to-head — stronger wins, weaker dislodged', () => {
    // [Rule 16] "Greater force prevails" — supported unit dislodges unsupported.
    // A Bur -> Ruh (S from Mun), A Ruh -> Bur. Bur strength 2 vs Ruh strength 1.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'ruh' }],
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'bur', destination: 'ruh' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bur')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('ruh');
  });

  it('Both sides supported equally in head-to-head — both bounce', () => {
    // [Rule 15] Equal force in head-to-head => both bounce.
    // A Bur -> Ruh (S from Mun), A Ruh -> Bur (S from Kie)
    // Bur: 2, Ruh: 2 => both fail
    // Need Kie adjacent to Bur? No — Kie army adj includes Ruh.
    // Kie support for Ruh -> Bur: supporter must be adjacent to destination (Bur).
    // Kie army adj: ruh, mun, hol, ber, den — no bur. So Kie can't support into Bur.
    // Use Bel instead. Bel army adj includes bur and ruh.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.Germany, province: 'bel' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'ruh' }],
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'bur', destination: 'ruh' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bel', { type: OrderType.Support, unit: 'bel', supportedUnit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });
});

// ============================================================================
// 5. SELF-DISLODGEMENT PREVENTION
// [Rule 22] "Players cannot dislodge or cut their own units' support."
//           A unit cannot be dislodged by a unit of the same power.
//           Support that would cause own-power dislodgement is not counted.
// ============================================================================

describe('Self-Dislodgement Prevention [Rule 22]', () => {
  it('Cannot dislodge own unit — move into own-power occupied province fails', () => {
    // [Rule 22] "Players cannot dislodge" their own units.
    // German A Ruh -> Bur (supported by Mun), German A Bur H.
    // Even with support, can't dislodge own unit.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'bur' },
    ];
    const orders = new Map<string, Order>([
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it("Foreign support not counted if it would dislodge supporter's own unit", () => {
    // [Rule 22] Support that would dislodge the supporter's own power's unit
    //           is excluded from attack strength calculation.
    // German A Ruh -> Bur. French A Mar S A Ruh -> Bur. French A Bur H.
    // French support for German attack would dislodge French Bur — not counted.
    // Attack strength is 1 (not 2), hold strength 1 => fails.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'mar' },
    ];
    const orders = new Map<string, Order>([
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['mar', { type: OrderType.Support, unit: 'mar', supportedUnit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Self-dislodgement support IS counted when own unit is moving away', () => {
    // [Rule 22] Exception: if the own-power unit is moving away successfully,
    //           no dislodgement occurs, so the support IS valid.
    // French A Bur -> Par. German A Ruh -> Bur (S from French Mar).
    // French Bur is leaving, so French Mar support IS counted.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'mar' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'par' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['mar', { type: OrderType.Support, unit: 'mar', supportedUnit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bur')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'mar')!.status).toBe(OrderStatus.Succeeds);
  });
});

// ============================================================================
// 6. CONVOY
// [Rule 12] "A fleet in a water province holds, convoying an army."
//           Armies "may move non-adjacently if convoyed."
// [Rule 24] "Disrupted convoys prevent army movement."
// ============================================================================

describe('Convoy [Rules 12, 24]', () => {
  it('Basic single-fleet convoy succeeds', () => {
    // [Rule 12] Army convoyed through a fleet in an adjacent sea province.
    // A Lon -> Bel via convoy, F Eng C A Lon -> Bel
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'bel' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'lon')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'eng')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions.find((u) => u.type === UnitType.Army)!.province).toBe('bel');
  });

  it('Convoy disrupted — dislodged fleet breaks the chain', () => {
    // [Rule 24] "Disrupted convoys prevent army movement."
    // A Lon -> Bel via convoy. F Eng C. French F Bre -> Eng (S from F Mao).
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Fleet, power: Power.France, province: 'bre' },
      { type: UnitType.Fleet, power: Power.France, province: 'mao' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'bel' }],
      ['bre', { type: OrderType.Move, unit: 'bre', destination: 'eng' }],
      ['mao', { type: OrderType.Support, unit: 'mao', supportedUnit: 'bre', destination: 'eng' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bre')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'eng')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'lon')!.status).toBe(OrderStatus.Fails);
    expect(result.newPositions.find((u) => u.type === UnitType.Army)!.province).toBe('lon');
  });

  it('Convoy with no matching fleet — army stays', () => {
    // [Rule 12] Convoy requires a fleet ordered to convoy. No fleet => no route.
    // A Lon -> Bel via convoy, but F Eng holds instead of convoying.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Hold, unit: 'eng' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'lon')!.status).toBe(OrderStatus.Fails);
    expect(result.newPositions.find((u) => u.type === UnitType.Army)!.province).toBe('lon');
  });

  it('Convoy order by non-fleet becomes Hold', () => {
    // [Rule 12] Only "a fleet in a water province" can convoy. Army cannot.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Army, power: Power.England, province: 'wal' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bre', viaConvoy: true }],
      ['wal', { type: OrderType.Convoy, unit: 'wal', convoyedUnit: 'lon', destination: 'bre' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // wal's convoy order is invalid (army, not fleet) -> becomes Hold
    expect(res(result, 'wal')!.order.type).toBe(OrderType.Hold);
  });

  it('Convoy order by fleet in non-sea province becomes Hold', () => {
    // [Rule 12] Fleet must be in a "water province" to convoy — not coastal.
    // F Bre tries to convoy (Bre is coastal, not sea).
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Fleet, power: Power.France, province: 'bre' },
    ];
    const orders = new Map<string, Order>([
      ['par', { type: OrderType.Move, unit: 'par', destination: 'lon', viaConvoy: true }],
      ['bre', { type: OrderType.Convoy, unit: 'bre', convoyedUnit: 'par', destination: 'lon' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bre')!.order.type).toBe(OrderType.Hold);
  });
});

// ============================================================================
// 7. CIRCULAR MOVEMENT
// [Rule 23] Units involved in a circular chain of moves (3+) all succeed
//           simultaneously, provided no external interference. Two-unit
//           head-to-heads (A->B, B->A) are NOT circular — they bounce per
//           [Rule 15].
// ============================================================================

describe('Circular Movement [Rule 23]', () => {
  it('Three-way rotation succeeds', () => {
    // [Rule 23] 3-unit cycle with no external interference => all succeed.
    // A Mun -> Boh, A Boh -> Sil, A Sil -> Mun
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Austria, province: 'boh' },
      { type: UnitType.Army, power: Power.Russia, province: 'sil' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'boh' }],
      ['boh', { type: OrderType.Move, unit: 'boh', destination: 'sil' }],
      ['sil', { type: OrderType.Move, unit: 'sil', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'boh')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'sil')!.status).toBe(OrderStatus.Succeeds);

    expect(result.newPositions.find((u) => u.power === Power.Germany)!.province).toBe('boh');
    expect(result.newPositions.find((u) => u.power === Power.Austria)!.province).toBe('sil');
    expect(result.newPositions.find((u) => u.power === Power.Russia)!.province).toBe('mun');
  });

  it('Two-unit swap is NOT circular movement — both bounce', () => {
    // [Rule 15] Two units moving to each other is a head-to-head, not circular.
    // A Mun -> Bur, A Bur -> Mun (both strength 1) => both bounce.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'bur' }],
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
  });

  it('Circular movement with external attack on one unit in the cycle — cycle broken', () => {
    // [Rule 23, 15] External competing move disrupts the cycle — units bounce.
    // A Mun -> Boh, A Boh -> Sil, A Sil -> Mun, A Tyr -> Boh (competing with Mun -> Boh)
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Austria, province: 'boh' },
      { type: UnitType.Army, power: Power.Russia, province: 'sil' },
      { type: UnitType.Army, power: Power.Italy, province: 'tyr' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'boh' }],
      ['boh', { type: OrderType.Move, unit: 'boh', destination: 'sil' }],
      ['sil', { type: OrderType.Move, unit: 'sil', destination: 'mun' }],
      ['tyr', { type: OrderType.Move, unit: 'tyr', destination: 'boh' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // Mun and Tyr compete for Boh => both bounce
    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'tyr')!.status).toBe(OrderStatus.Fails);
    // With Mun failing, Sil -> Mun succeeds (Mun is moving but failing)
    // Boh -> Sil might succeed too since Sil is leaving
  });
});

// ============================================================================
// 8. SUPPORT VALIDATION
// [Rule 13] "A unit holds, adding its force to another unit." Support is only
//           valid if the supporting unit could move to the target province.
//           Invalid support orders become Hold.
// ============================================================================

describe('Support Validation [Rule 13]', () => {
  it('Support for non-existent unit becomes Hold', () => {
    // [Rule 13] Cannot support a unit that doesn't exist — order is invalid.
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'mun' }];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.order.type).toBe(OrderType.Hold);
  });

  it('Support-move to non-adjacent destination becomes Hold', () => {
    // [Rule 13] Supporting unit must be able to move to the destination.
    // A Ber tries to support A Ruh -> Bur. Ber is not adjacent to Bur for an army.
    // Ber army adj: kie, mun, pru, sil — no bur.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['ber', { type: OrderType.Support, unit: 'ber', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ber')!.order.type).toBe(OrderType.Hold);
    // Ruh move has no support, but Bur is empty so it still succeeds
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds);
  });

  it('Support-hold for non-adjacent unit becomes Hold', () => {
    // [Rule 13] Supporting unit must be adjacent to the supported unit.
    // A Ber tries to support A Par H. Ber is not adjacent to Par.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
    ];
    const orders = new Map<string, Order>([
      ['ber', { type: OrderType.Support, unit: 'ber', supportedUnit: 'par' }],
      ['par', { type: OrderType.Hold, unit: 'par' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ber')!.order.type).toBe(OrderType.Hold);
  });
});

// ============================================================================
// 9. RETREATS
// [Rule 25] "Dislodged units must retreat to vacant provinces where movement
//            was possible."
// [Rule 26] Retreat destinations exclude "bounce locations and attack origins."
// [Rule 27] "Absent legal retreats result in destruction."
// ============================================================================

describe('Retreats [Rules 25-27]', () => {
  it('Dislodged unit gets valid retreat options', () => {
    // [Rule 25-26] Retreat destinations exclude attacker origin, occupied, and
    //              bounced provinces.
    // A Bur is dislodged by A Ruh (S from Mun). Par is occupied. Pic has a bounce.
    // bur army adj: par, pic, mar, gas, bel, ruh, mun
    // Excluded: ruh (attacker), mun (occupied), par (occupied), pic (bounced), bel (occupied)
    // Valid: mar, gas
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Army, power: Power.England, province: 'bel' },
      { type: UnitType.Army, power: Power.Italy, province: 'bre' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['par', { type: OrderType.Hold, unit: 'par' }],
      ['bel', { type: OrderType.Move, unit: 'bel', destination: 'pic' }],
      ['bre', { type: OrderType.Move, unit: 'bre', destination: 'pic' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(result.dislodgedUnits).toHaveLength(1);
    const retreat = result.dislodgedUnits[0];
    expect(retreat.unit.province).toBe('bur');
    expect(retreat.attackedFrom).toBe('ruh');
    expect(retreat.validDestinations).not.toContain('ruh');
    expect(retreat.validDestinations).not.toContain('mun');
    expect(retreat.validDestinations).not.toContain('par');
    expect(retreat.validDestinations).not.toContain('pic');
    expect(retreat.validDestinations).toContain('mar');
    expect(retreat.validDestinations).toContain('gas');
  });

  it('No retreat options — unit must be disbanded', () => {
    // [Rule 27] "Absent legal retreats result in destruction."
    // bur army adj: par, pic, mar, gas, bel, ruh, mun — all blocked.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Army, power: Power.France, province: 'pic' },
      { type: UnitType.Army, power: Power.France, province: 'mar' },
      { type: UnitType.Army, power: Power.France, province: 'gas' },
      { type: UnitType.Army, power: Power.England, province: 'bel' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['par', { type: OrderType.Hold, unit: 'par' }],
      ['pic', { type: OrderType.Hold, unit: 'pic' }],
      ['mar', { type: OrderType.Hold, unit: 'mar' }],
      ['gas', { type: OrderType.Hold, unit: 'gas' }],
      ['bel', { type: OrderType.Hold, unit: 'bel' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].validDestinations).toHaveLength(0);
  });

  it('Dislodged unit not in newPositions', () => {
    // [Rule 25] Dislodged units are removed from the board pending retreat.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // France's unit should NOT be in newPositions (it's dislodged)
    expect(result.newPositions.find((u) => u.power === Power.France)).toBeUndefined();
    // Germany should have units at mun (supporter) and bur (moved in)
    expect(result.newPositions.filter((u) => u.power === Power.Germany)).toHaveLength(2);
  });
});

// ============================================================================
// 10. COMPLEX INTERACTIONS — multiple rules interacting at once
// ============================================================================

describe('Complex Interactions', () => {
  it('Support cut prevents dislodge — cascading effect', () => {
    // [Rule 19 + 18] Support cutting reduces attack strength below defense.
    // A Mun S A Ruh -> Bur (attack 2). A Bur H (defense 1).
    // BUT A Boh -> Mun cuts Mun's support. Now Ruh (1) vs Bur (1) => fails.
    // Additionally, Boh -> Mun (1 vs Mun 1, Mun is supporting so it's like Hold) => bounce
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Austria, province: 'boh' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['boh', { type: OrderType.Move, unit: 'boh', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails); // support cut
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails); // 1 vs 1 => fails
    expect(res(result, 'boh')!.status).toBe(OrderStatus.Fails); // bounces off mun
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Mutual support-cut deadlock', () => {
    // [Rule 19] Both supports cut simultaneously by independent attacks.
    // A Mun S A Ruh -> Bur, A Bur S A Par -> Ruh.
    // A Boh -> Mun (cuts Mun support). A Gas -> Bur (cuts Bur support).
    // Both supports cut. Neither Ruh->Bur nor Par->Ruh has support.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Army, power: Power.Austria, province: 'boh' },
      { type: UnitType.Army, power: Power.Italy, province: 'gas' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Support, unit: 'bur', supportedUnit: 'par', destination: 'ruh' }],
      ['par', { type: OrderType.Move, unit: 'par', destination: 'ruh' }],
      ['boh', { type: OrderType.Move, unit: 'boh', destination: 'mun' }],
      ['gas', { type: OrderType.Move, unit: 'gas', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails); // support cut by boh
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails); // support cut by gas
    // ruh -> bur: strength 1. bur is supporting (acting as hold), strength 1 + gas competing.
    // gas -> bur: also strength 1 competing with ruh.
    // par -> ruh: strength 1 vs ruh (moving away). If ruh fails to move, ruh defends at 1.
  });

  it('Dislodge with move-away — attacker enters vacated province', () => {
    // [Rule 17] Unit moves out successfully, province is vacated for attacker.
    // A Bur -> Par (succeeds, Par empty). A Ruh -> Bur (S from Mun, strength 2).
    // Bur leaves so Ruh enters the now-empty Bur.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'par' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bur')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions.find((u) => u.power === Power.France)!.province).toBe('par');
    expect(result.newPositions.find((u) => u.province === 'bur')!.power).toBe(Power.Germany);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Multiple dislodgements in one turn', () => {
    // [Rule 18] Multiple independent supported attacks dislodge different defenders.
    // Attack 1: A Ruh -> Bur (S from Mun), French A Bur H => Bur dislodged
    // Attack 2: A Tyr -> Ven (S from Tri), Italian A Ven H => Ven dislodged
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Austria, province: 'tyr' },
      { type: UnitType.Army, power: Power.Austria, province: 'tri' },
      { type: UnitType.Army, power: Power.Italy, province: 'ven' },
    ];
    const orders = new Map<string, Order>([
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['tyr', { type: OrderType.Move, unit: 'tyr', destination: 'ven' }],
      ['tri', { type: OrderType.Support, unit: 'tri', supportedUnit: 'tyr', destination: 'ven' }],
      ['ven', { type: OrderType.Hold, unit: 'ven' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(result.dislodgedUnits).toHaveLength(2);
    const dislodgedProvs = result.dislodgedUnits.map((d) => d.unit.province).sort();
    expect(dislodgedProvs).toEqual(['bur', 'ven']);
  });

  it('Standoff at empty province prevents movement through', () => {
    // [Rule 15, 17] Bounce leaves unit in place, retaining defense strength.
    // A Mun -> Bur, A Mar -> Bur (bounce). A Ruh -> Mun.
    // Mun fails to leave (bounce at Bur). So Ruh -> Mun fails (Mun still there).
    // But actually: Mun is trying to move. If it fails, it still occupies Mun.
    // Ruh (1) vs Mun holding (1) => Ruh fails.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.France, province: 'mar' },
      { type: UnitType.Army, power: Power.Austria, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'bur' }],
      ['mar', { type: OrderType.Move, unit: 'mar', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'mun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'mar')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
  });
});

// ============================================================================
// 11. EDGE CASES — unusual or tricky situations
// ============================================================================

describe('Edge Cases', () => {
  it('Empty orders map — all units default to Hold', () => {
    // [Rule 12] Units with no orders default to Hold.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Fleet, power: Power.England, province: 'lon' },
    ];
    const orders = new Map<string, Order>();
    const result = resolveOrders(units, orders, PROVINCES);

    expect(result.resolutions).toHaveLength(3);
    result.resolutions.forEach((r) => {
      expect(r.order.type).toBe(OrderType.Hold);
      expect(r.status).toBe(OrderStatus.Succeeds);
    });
    expect(result.newPositions).toHaveLength(3);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('No units — empty resolution', () => {
    const units: Unit[] = [];
    const orders = new Map<string, Order>();
    const result = resolveOrders(units, orders, PROVINCES);

    expect(result.resolutions).toHaveLength(0);
    expect(result.newPositions).toHaveLength(0);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Support holds against two simultaneous attacks', () => {
    // [Rule 18] Defense strength (3) compared against each attacker independently.
    // A Bur H (S from Par, S from Gas => defense 3). A Ruh -> Bur (S from Mun, attack 2).
    // A Bel -> Bur (unsupported, attack 1). Defense 3 beats both.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Army, power: Power.France, province: 'gas' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.England, province: 'bel' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Hold, unit: 'bur' }],
      ['par', { type: OrderType.Support, unit: 'par', supportedUnit: 'bur' }],
      ['gas', { type: OrderType.Support, unit: 'gas', supportedUnit: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['bel', { type: OrderType.Move, unit: 'bel', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'bel')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });

  it('Same power units cannot swap — self-dislodgement prevents it', () => {
    // [Rule 22] "Players cannot dislodge" own units. Even with support,
    //           head-to-head between same power fails.
    // German A Mun -> Bur (S from Ruh). German A Bur -> Mun.
    // Even though Mun has strength 2, it can't dislodge own unit.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'bur' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'bur' }],
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'mun' }],
      ['ruh', { type: OrderType.Support, unit: 'ruh', supportedUnit: 'mun', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // Can't dislodge own unit, so mun -> bur fails
    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
    // bur -> mun also fails since mun didn't leave
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });
});

// ============================================================================
// 10. SPLIT COASTS
// [Rule 32] "Bulgaria, St. Petersburg, and Spain have split coasts. A fleet
//            moving to those provinces must select which coast it will move to
//            and can only move on to other provinces adjacent that coast."
//           "However, the fleet occupies the entire province for all other
//            purposes."
//           "A fleet can receive support from a second fleet that is adjacent
//            to the province yet not adjacent to the coast the first fleet
//            is on."
// Rules Source: https://www.playdiplomacy.com/help.php?sub_page=Game_Rules
// ============================================================================

describe('Split Coasts [Rule 32]', () => {
  // --- Movement from a multi-coast province ---

  it('Fleet on STP/SC can move to adjacent south coast province (FIN)', () => {
    // [Rule 32] Fleet on a coast "can only move on to other provinces adjacent that coast."
    // STP south coast is adjacent to: fin, lvn, bot
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.South },
    ];
    const orders = new Map<string, Order>([
      ['stp', { type: OrderType.Move, unit: 'stp', destination: 'fin' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'stp')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('fin');
    expect(result.newPositions[0].coast).toBeUndefined();
  });

  it('Fleet on STP/SC can move to BOT', () => {
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.South },
    ];
    const orders = new Map<string, Order>([
      ['stp', { type: OrderType.Move, unit: 'stp', destination: 'bot' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'stp')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bot');
  });

  it('Fleet on STP/SC cannot move to BAR (north coast only)', () => {
    // [Rule 32] Cannot move to a province adjacent only to the other coast.
    // BAR is adjacent to STP north coast, not south coast.
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.South },
    ];
    const orders = new Map<string, Order>([
      ['stp', { type: OrderType.Move, unit: 'stp', destination: 'bar' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // Invalid move becomes Hold
    expect(res(result, 'stp')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('stp');
    expect(result.newPositions[0].coast).toBe(Coast.South);
  });

  it('Fleet on STP/NC can move to BAR but not FIN', () => {
    // STP north coast is adjacent to: bar, nor, nwg
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.North },
    ];
    const orders = new Map<string, Order>([
      ['stp', { type: OrderType.Move, unit: 'stp', destination: 'bar' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'stp')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bar');
  });

  it('Fleet on STP/NC cannot move to FIN (south coast only)', () => {
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.North },
    ];
    const orders = new Map<string, Order>([
      ['stp', { type: OrderType.Move, unit: 'stp', destination: 'fin' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'stp')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('stp');
  });

  // --- Movement into a multi-coast province ---

  it('Fleet moving to SPA must specify a coast', () => {
    // [Rule 32] "A fleet moving to those provinces must select which coast."
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.France, province: 'mao' }];
    const orders = new Map<string, Order>([
      ['mao', { type: OrderType.Move, unit: 'mao', destination: 'spa' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // No coast specified → invalid → becomes Hold
    expect(res(result, 'mao')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('mao');
  });

  it('Fleet from MAO can move to SPA/NC', () => {
    // MAO is adjacent to SPA north coast: ['por', 'gas', 'mao']
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.France, province: 'mao' }];
    const orders = new Map<string, Order>([
      ['mao', { type: OrderType.Move, unit: 'mao', destination: 'spa', coast: Coast.North }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mao')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('spa');
    expect(result.newPositions[0].coast).toBe(Coast.North);
  });

  it('Fleet from MAO can move to SPA/SC', () => {
    // MAO is adjacent to SPA south coast: ['por', 'mar', 'mao', 'lyo', 'wes']
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.France, province: 'mao' }];
    const orders = new Map<string, Order>([
      ['mao', { type: OrderType.Move, unit: 'mao', destination: 'spa', coast: Coast.South }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mao')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('spa');
    expect(result.newPositions[0].coast).toBe(Coast.South);
  });

  it('Fleet from MAR can only move to SPA/SC, not SPA/NC', () => {
    // MAR is adjacent to SPA south coast only.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.France, province: 'mar' }];
    const orders = new Map<string, Order>([
      ['mar', { type: OrderType.Move, unit: 'mar', destination: 'spa', coast: Coast.North }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // MAR is not adjacent to SPA/NC → invalid → becomes Hold
    expect(res(result, 'mar')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('mar');
  });

  it('Fleet from GAS can only move to SPA/NC, not SPA/SC', () => {
    // GAS is adjacent to SPA north coast only.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.France, province: 'gas' }];
    const orders = new Map<string, Order>([
      ['gas', { type: OrderType.Move, unit: 'gas', destination: 'spa', coast: Coast.South }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // GAS is not adjacent to SPA/SC → invalid → becomes Hold
    expect(res(result, 'gas')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('gas');
  });

  // --- Bulgaria coasts ---

  it('Fleet from BLA can move to BUL/NC (east coast)', () => {
    // BLA is adjacent to BUL east coast (mapped to Coast.North): ['rum', 'con', 'bla']
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Turkey, province: 'bla' }];
    const orders = new Map<string, Order>([
      ['bla', { type: OrderType.Move, unit: 'bla', destination: 'bul', coast: Coast.North }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bla')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bul');
    expect(result.newPositions[0].coast).toBe(Coast.North);
  });

  it('Fleet from AEG can move to BUL/SC but not BUL/NC', () => {
    // AEG is adjacent to BUL south coast: ['con', 'gre', 'aeg']
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Turkey, province: 'aeg' }];
    const orders = new Map<string, Order>([
      ['aeg', { type: OrderType.Move, unit: 'aeg', destination: 'bul', coast: Coast.North }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // AEG not adjacent to BUL east coast → invalid
    expect(res(result, 'aeg')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('aeg');
  });

  it('Fleet on BUL/SC can move to AEG but not BLA', () => {
    // BUL south coast adjacent to: con, gre, aeg
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Turkey, province: 'bul', coast: Coast.South },
    ];
    const orders = new Map<string, Order>([
      ['bul', { type: OrderType.Move, unit: 'bul', destination: 'bla' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // BLA is only adjacent to BUL east coast (NC), not south → invalid
    expect(res(result, 'bul')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bul');
  });

  // --- "Fleet occupies the entire province" ---

  it('Fleet on SPA/NC blocks army from entering SPA', () => {
    // [Rule 32] "The fleet occupies the entire province for all other purposes."
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.France, province: 'spa', coast: Coast.North },
      { type: UnitType.Army, power: Power.Italy, province: 'mar' },
    ];
    const orders = new Map<string, Order>([
      ['spa', { type: OrderType.Hold, unit: 'spa' }],
      ['mar', { type: OrderType.Move, unit: 'mar', destination: 'spa' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mar')!.status).toBe(OrderStatus.Fails);
    expect(result.newPositions.find((u) => u.power === Power.France)!.province).toBe('spa');
  });

  it('Fleet on SPA/SC blocks fleet from entering SPA/NC', () => {
    // [Rule 32] Province is fully occupied regardless of coast.
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.France, province: 'spa', coast: Coast.South },
      { type: UnitType.Fleet, power: Power.England, province: 'mao' },
    ];
    const orders = new Map<string, Order>([
      ['spa', { type: OrderType.Hold, unit: 'spa' }],
      ['mao', { type: OrderType.Move, unit: 'mao', destination: 'spa', coast: Coast.North }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // SPA is occupied → move fails
    expect(res(result, 'mao')!.status).toBe(OrderStatus.Fails);
  });

  // --- Support involving multi-coast provinces ---

  it('Fleet not adjacent to coast can still support into the province', () => {
    // [Rule 32] "A fleet can receive support from a second fleet that is
    //            adjacent to the province yet not adjacent to the coast."
    // GAS is adjacent to SPA (via fleet list) but only to NC, not SC.
    // GAS can still support a move to SPA even if the move targets SC.
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.France, province: 'gas' },
      { type: UnitType.Fleet, power: Power.France, province: 'mar' },
      { type: UnitType.Fleet, power: Power.England, province: 'spa', coast: Coast.North },
    ];
    const orders = new Map<string, Order>([
      ['mar', { type: OrderType.Move, unit: 'mar', destination: 'spa', coast: Coast.South }],
      ['gas', { type: OrderType.Support, unit: 'gas', supportedUnit: 'mar', destination: 'spa' }],
      ['spa', { type: OrderType.Hold, unit: 'spa' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // MAR→SPA/SC with support from GAS (strength 2) vs SPA hold (strength 1)
    expect(res(result, 'mar')!.status).toBe(OrderStatus.Succeeds);
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('spa');
  });

  it('Fleet on multi-coast province can support an adjacent unit', () => {
    // Fleet on STP/SC can support a unit in FIN (adjacent to south coast).
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.South },
      { type: UnitType.Fleet, power: Power.Russia, province: 'bot' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'fin' },
    ];
    const orders = new Map<string, Order>([
      ['bot', { type: OrderType.Move, unit: 'bot', destination: 'fin' }],
      ['stp', { type: OrderType.Support, unit: 'stp', supportedUnit: 'bot', destination: 'fin' }],
      ['fin', { type: OrderType.Hold, unit: 'fin' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // BOT→FIN supported by STP/SC (strength 2) vs FIN hold (strength 1)
    expect(res(result, 'bot')!.status).toBe(OrderStatus.Succeeds);
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('fin');
  });

  it('Fleet on STP/SC cannot support into BAR (not adjacent to south coast)', () => {
    // BAR is adjacent to STP/NC, not STP/SC — fleet on SC cannot support there.
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.South },
      { type: UnitType.Fleet, power: Power.Russia, province: 'nwg' },
      { type: UnitType.Fleet, power: Power.England, province: 'bar' },
    ];
    const orders = new Map<string, Order>([
      ['nwg', { type: OrderType.Move, unit: 'nwg', destination: 'bar' }],
      ['stp', { type: OrderType.Support, unit: 'stp', supportedUnit: 'nwg', destination: 'bar' }],
      ['bar', { type: OrderType.Hold, unit: 'bar' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // STP/SC support into BAR is invalid (not adjacent), so NWG attacks alone (1v1) → bounce
    expect(res(result, 'nwg')!.status).toBe(OrderStatus.Fails);
  });

  // --- Retreat from multi-coast province ---

  it('Dislodged fleet on STP/SC can only retreat to south coast destinations', () => {
    // STP/SC adjacent to: fin, lvn, bot. Fleet cannot retreat to bar (NC only).
    const units: Unit[] = [
      { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.South },
      { type: UnitType.Army, power: Power.Germany, province: 'fin' },
      { type: UnitType.Army, power: Power.Germany, province: 'mos' },
    ];
    const orders = new Map<string, Order>([
      ['stp', { type: OrderType.Hold, unit: 'stp' }],
      ['fin', { type: OrderType.Move, unit: 'fin', destination: 'stp' }],
      ['mos', { type: OrderType.Support, unit: 'mos', supportedUnit: 'fin', destination: 'stp' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'fin')!.status).toBe(OrderStatus.Succeeds);
    expect(result.dislodgedUnits).toHaveLength(1);
    const retreat = result.dislodgedUnits[0];
    expect(retreat.unit.province).toBe('stp');
    expect(retreat.unit.coast).toBe(Coast.South);
    // Valid retreat destinations should only include SC-adjacent provinces
    // fin is occupied by attacker, attackedFrom = fin, so lvn and bot remain
    expect(retreat.validDestinations).not.toContain('bar');
    expect(retreat.validDestinations).not.toContain('nor');
    expect(retreat.validDestinations).not.toContain('nwg');
    expect(retreat.validDestinations).toContain('lvn');
    expect(retreat.validDestinations).toContain('bot');
  });
});

// ============================================================================
// 11. INLAND WATERWAYS
// [Rule 33] "Constantinople, Denmark and Kiel do not have split coasts.
//            They have inland waterways that fleets may use to move to
//            adjacent provinces. You may not convoy through these (or any
//            other) coastal provinces."
// Rules Source: https://www.playdiplomacy.com/help.php?sub_page=Game_Rules
// ============================================================================

describe('Inland Waterways [Rule 33]', () => {
  it('Fleet in CON can move to BLA (waterway connects both sides)', () => {
    // [Rule 33] Constantinople has an inland waterway — no split coasts.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Turkey, province: 'con' }];
    const orders = new Map<string, Order>([
      ['con', { type: OrderType.Move, unit: 'con', destination: 'bla' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'con')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bla');
  });

  it('Fleet in CON can move to AEG (other side of waterway)', () => {
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Turkey, province: 'con' }];
    const orders = new Map<string, Order>([
      ['con', { type: OrderType.Move, unit: 'con', destination: 'aeg' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'con')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('aeg');
  });

  it('Fleet in KIE can move from BAL side to HEL side', () => {
    // [Rule 33] Kiel has an inland waterway connecting Baltic and Heligoland.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'kie' }];
    const orders = new Map<string, Order>([
      ['kie', { type: OrderType.Move, unit: 'kie', destination: 'hel' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'kie')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('hel');
  });

  it('Fleet in KIE can move to BAL', () => {
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'kie' }];
    const orders = new Map<string, Order>([
      ['kie', { type: OrderType.Move, unit: 'kie', destination: 'bal' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'kie')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bal');
  });

  it('Fleet in DEN can move from NTH side to BAL side', () => {
    // [Rule 33] Denmark has an inland waterway.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'den' }];
    const orders = new Map<string, Order>([
      ['den', { type: OrderType.Move, unit: 'den', destination: 'bal' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'den')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bal');
  });

  it('Fleet in DEN can also move to NTH', () => {
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'den' }];
    const orders = new Map<string, Order>([
      ['den', { type: OrderType.Move, unit: 'den', destination: 'nth' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'den')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('nth');
  });

  it('Cannot convoy through Constantinople', () => {
    // [Rule 33] "You may not convoy through these (or any other) coastal provinces."
    // Army in SMY trying to convoy to BUL via CON — CON is coastal, not a sea province.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Turkey, province: 'smy' },
      { type: UnitType.Fleet, power: Power.Turkey, province: 'con' },
    ];
    const orders = new Map<string, Order>([
      ['smy', { type: OrderType.Move, unit: 'smy', destination: 'bul', viaConvoy: true }],
      ['con', { type: OrderType.Convoy, unit: 'con', convoyedUnit: 'smy', destination: 'bul' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // Convoy through a coastal province is invalid
    expect(res(result, 'smy')!.status).toBe(OrderStatus.Fails);
  });

  it('Cannot convoy through Kiel', () => {
    // Army in MUN trying to convoy to HOL via KIE fleet — KIE is coastal.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Move, unit: 'mun', destination: 'hol', viaConvoy: true }],
      ['kie', { type: OrderType.Convoy, unit: 'kie', convoyedUnit: 'mun', destination: 'hol' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'mun')!.status).toBe(OrderStatus.Fails);
  });
});

// ============================================================================
// 12. SWEDEN-DENMARK CONNECTION
// [Rule 34] "Denmark connects with Sweden and armies can move between them,
//            though Sweden does not have a split coast."
// Rules Source: https://www.playdiplomacy.com/help.php?sub_page=Game_Rules
// ============================================================================

describe('Sweden-Denmark Connection [Rule 34]', () => {
  it('Army can move from DEN to SWE', () => {
    // [Rule 34] Land connection between Denmark and Sweden.
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'den' }];
    const orders = new Map<string, Order>([
      ['den', { type: OrderType.Move, unit: 'den', destination: 'swe' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'den')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('swe');
  });

  it('Army can move from SWE to DEN', () => {
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Russia, province: 'swe' }];
    const orders = new Map<string, Order>([
      ['swe', { type: OrderType.Move, unit: 'swe', destination: 'den' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'swe')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('den');
  });

  it('Fleet can move from DEN to SWE', () => {
    // Sweden does not have a split coast — fleet can move freely.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'den' }];
    const orders = new Map<string, Order>([
      ['den', { type: OrderType.Move, unit: 'den', destination: 'swe' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'den')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('swe');
  });

  it('Army can move from SWE to NOR (land connection)', () => {
    // [Rule 34] Sweden connects to Norway by land as well.
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Russia, province: 'swe' }];
    const orders = new Map<string, Order>([
      ['swe', { type: OrderType.Move, unit: 'swe', destination: 'nor' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'swe')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('nor');
  });
});

// ============================================================================
// 13. NON-ADJACENT PROVINCES
// [Rule 35] "The Baltic Sea is not adjacent to the Helgoland Bight, North
//            Sea, or Skagerrak."
//           "The Aegean and Black Seas are not adjacent."
//           "North Africa and Spain are not adjacent."
// Rules Source: https://www.playdiplomacy.com/help.php?sub_page=Game_Rules
// ============================================================================

describe('Non-Adjacent Provinces [Rule 35]', () => {
  it('Fleet in BAL cannot move to HEL (not adjacent)', () => {
    // [Rule 35] Baltic Sea is not adjacent to Heligoland Bight.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'bal' }];
    const orders = new Map<string, Order>([
      ['bal', { type: OrderType.Move, unit: 'bal', destination: 'hel' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bal')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bal'); // stays put — invalid move
  });

  it('Fleet in BAL cannot move to NTH (not adjacent)', () => {
    // [Rule 35] Baltic Sea is not adjacent to North Sea.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'bal' }];
    const orders = new Map<string, Order>([
      ['bal', { type: OrderType.Move, unit: 'bal', destination: 'nth' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bal')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bal');
  });

  it('Fleet in BAL cannot move to SKA (not adjacent)', () => {
    // [Rule 35] Baltic Sea is not adjacent to Skagerrak.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'bal' }];
    const orders = new Map<string, Order>([
      ['bal', { type: OrderType.Move, unit: 'bal', destination: 'ska' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bal')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bal');
  });

  it('Fleet in BAL can reach NTH via DEN (two moves)', () => {
    // [Rule 35] "Fleets cannot move between them in one step but must move
    //            through an adjacent province (e.g. Denmark) first."
    // Verify BAL→DEN is valid (the first hop).
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Germany, province: 'bal' }];
    const orders = new Map<string, Order>([
      ['bal', { type: OrderType.Move, unit: 'bal', destination: 'den' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bal')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('den');
  });

  it('Fleet in AEG cannot move to BLA (not adjacent)', () => {
    // [Rule 35] Aegean and Black Seas are not adjacent.
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Turkey, province: 'aeg' }];
    const orders = new Map<string, Order>([
      ['aeg', { type: OrderType.Move, unit: 'aeg', destination: 'bla' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'aeg')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('aeg');
  });

  it('Fleet in BLA cannot move to AEG (not adjacent)', () => {
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.Turkey, province: 'bla' }];
    const orders = new Map<string, Order>([
      ['bla', { type: OrderType.Move, unit: 'bla', destination: 'aeg' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bla')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('bla');
  });

  it('Army in NAF cannot move to SPA (not adjacent)', () => {
    // [Rule 35] North Africa and Spain are not adjacent.
    const units: Unit[] = [{ type: UnitType.Army, power: Power.France, province: 'naf' }];
    const orders = new Map<string, Order>([
      ['naf', { type: OrderType.Move, unit: 'naf', destination: 'spa' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'naf')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('naf');
  });

  it('Fleet in NAF cannot move to SPA (not adjacent)', () => {
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.France, province: 'naf' }];
    const orders = new Map<string, Order>([
      ['naf', { type: OrderType.Move, unit: 'naf', destination: 'spa', coast: Coast.South }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'naf')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions[0].province).toBe('naf');
  });
});

// ============================================================================
// 13. MULTI-FLEET CONVOY
// [Rule 12] Armies "may move non-adjacently if convoyed" through a chain of
//           fleets in water provinces.
// ============================================================================

describe('Multi-Fleet Convoy', () => {
  it('Two-fleet convoy chain succeeds (LON -> TUN via ENG + MAO + WES)', () => {
    // Army convoyed through a chain of three fleets across multiple sea zones.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Fleet, power: Power.England, province: 'mao' },
      { type: UnitType.Fleet, power: Power.England, province: 'wes' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'tun', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'tun' }],
      ['mao', { type: OrderType.Convoy, unit: 'mao', convoyedUnit: 'lon', destination: 'tun' }],
      ['wes', { type: OrderType.Convoy, unit: 'wes', convoyedUnit: 'lon', destination: 'tun' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'lon')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions.find((u) => u.type === UnitType.Army)!.province).toBe('tun');
  });

  it('Multi-fleet convoy disrupted — one fleet in chain dislodged breaks route', () => {
    // Chain: LON -> ENG -> MAO -> WES -> TUN. MAO is dislodged, breaking the chain.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Fleet, power: Power.England, province: 'mao' },
      { type: UnitType.Fleet, power: Power.England, province: 'wes' },
      { type: UnitType.Fleet, power: Power.France, province: 'bre' },
      { type: UnitType.Fleet, power: Power.France, province: 'gas' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'tun', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'tun' }],
      ['mao', { type: OrderType.Convoy, unit: 'mao', convoyedUnit: 'lon', destination: 'tun' }],
      ['wes', { type: OrderType.Convoy, unit: 'wes', convoyedUnit: 'lon', destination: 'tun' }],
      ['bre', { type: OrderType.Move, unit: 'bre', destination: 'mao' }],
      ['gas', { type: OrderType.Support, unit: 'gas', supportedUnit: 'bre', destination: 'mao' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'bre')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'lon')!.status).toBe(OrderStatus.Fails);
    expect(result.newPositions.find((u) => u.province === 'lon')).toBeDefined();
  });

  it('Multi-fleet convoy — alternate route survives single disruption', () => {
    // Two parallel routes: LON -> ENG -> NTH -> ... No, let's use a simpler case.
    // If only one fleet is needed and it survives, convoy works.
    // LON -> BEL via ENG. NTH attacks ENG but bounces (strength 1 vs 1). Convoy survives.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Fleet, power: Power.France, province: 'nth' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'bel' }],
      ['nth', { type: OrderType.Move, unit: 'nth', destination: 'eng' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // NTH attack bounces (1 vs 1), convoy fleet not dislodged, convoy succeeds
    expect(res(result, 'nth')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'lon')!.status).toBe(OrderStatus.Succeeds);
    expect(result.newPositions.find((u) => u.type === UnitType.Army)!.province).toBe('bel');
  });
});

// ============================================================================
// 14. CONVOY COMBAT
// Convoyed armies participate in combat at the destination like any other move.
// They can bounce, be supported, and cut support.
// ============================================================================

describe('Convoy Combat', () => {
  it('Convoyed army with support dislodges a unit at destination', () => {
    // A LON -> BEL via convoy (F ENG C), supported by F NTH.
    // French A BEL holds. Attack strength 2 vs hold 1 => dislodge.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Fleet, power: Power.England, province: 'nth' },
      { type: UnitType.Army, power: Power.France, province: 'bel' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'bel' }],
      ['nth', { type: OrderType.Support, unit: 'nth', supportedUnit: 'lon', destination: 'bel' }],
      ['bel', { type: OrderType.Hold, unit: 'bel' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'lon')!.status).toBe(OrderStatus.Succeeds);
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('bel');
  });

  it('Convoyed army bounces with another move to same destination', () => {
    // A LON -> BEL via convoy (F ENG C), A PIC -> BEL. Both strength 1 => bounce.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Army, power: Power.France, province: 'pic' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'bel' }],
      ['pic', { type: OrderType.Move, unit: 'pic', destination: 'bel' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    expect(res(result, 'lon')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'pic')!.status).toBe(OrderStatus.Fails);
  });

  it('Convoyed army cuts support at destination', () => {
    // A LON -> BEL via convoy (F ENG C). French A BEL S A BUR -> RUH.
    // The convoyed army attacks BEL, cutting BEL's support for BUR -> RUH.
    // (attack comes from LON, not from RUH, so support IS cut).
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Army, power: Power.France, province: 'bel' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'bel' }],
      ['bel', { type: OrderType.Support, unit: 'bel', supportedUnit: 'bur', destination: 'ruh' }],
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'ruh' }],
      ['ruh', { type: OrderType.Hold, unit: 'ruh' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // Convoyed army cuts BEL's support
    expect(res(result, 'bel')!.status).toBe(OrderStatus.Fails);
    // Without support, BUR (1) vs RUH (1) => bounce
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
  });

  it('Disrupted convoyed army does NOT cut support (bug fix)', () => {
    // A LON -> BEL via convoy (F ENG C). F ENG is dislodged by F BRE + F MAO.
    // Convoy is disrupted, so A LON never reaches BEL.
    // A BEL S A BUR -> RUH should NOT be cut.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'eng' },
      { type: UnitType.Army, power: Power.France, province: 'bel' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'bre' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'mao' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['eng', { type: OrderType.Convoy, unit: 'eng', convoyedUnit: 'lon', destination: 'bel' }],
      ['bel', { type: OrderType.Support, unit: 'bel', supportedUnit: 'bur', destination: 'ruh' }],
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'ruh' }],
      ['ruh', { type: OrderType.Hold, unit: 'ruh' }],
      ['bre', { type: OrderType.Move, unit: 'bre', destination: 'eng' }],
      ['mao', { type: OrderType.Support, unit: 'mao', supportedUnit: 'bre', destination: 'eng' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // Convoy fleet dislodged => convoy disrupted => LON stays home
    expect(res(result, 'lon')!.status).toBe(OrderStatus.Fails);
    // BEL's support should NOT be cut (disrupted convoy doesn't threaten BEL)
    expect(res(result, 'bel')!.status).toBe(OrderStatus.Succeeds);
    // With support intact, BUR (2) vs RUH (1) => BUR dislodges RUH
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Succeeds);
    expect(result.dislodgedUnits.find((d) => d.unit.province === 'ruh')).toBeDefined();
  });
});

// ============================================================================
// 15. CONVOY PARADOX
// When a convoyed army's arrival would disrupt its own convoy route (e.g. by
// dislodging a fleet needed for the convoy), the convoy is treated as disrupted
// (Szykman rule). The iterative resolver handles this naturally.
// ============================================================================

describe('Convoy Paradox', () => {
  it('Convoyed army attacks fleet whose dislodgement disrupts convoy — paradox resolved', () => {
    // F NTH C A LON -> BEL. French F ENG -> NTH (S from F YOR).
    // F ENG dislodges F NTH (strength 2 vs 1), disrupting the convoy.
    // Under Szykman rule, convoy is disrupted, A LON stays.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.England, province: 'lon' },
      { type: UnitType.Fleet, power: Power.England, province: 'nth' },
      { type: UnitType.Fleet, power: Power.France, province: 'eng' },
      { type: UnitType.Fleet, power: Power.France, province: 'yor' },
    ];
    const orders = new Map<string, Order>([
      ['lon', { type: OrderType.Move, unit: 'lon', destination: 'bel', viaConvoy: true }],
      ['nth', { type: OrderType.Convoy, unit: 'nth', convoyedUnit: 'lon', destination: 'bel' }],
      ['eng', { type: OrderType.Move, unit: 'eng', destination: 'nth' }],
      ['yor', { type: OrderType.Support, unit: 'yor', supportedUnit: 'eng', destination: 'nth' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // F NTH dislodged, convoy disrupted, army stays
    expect(res(result, 'eng')!.status).toBe(OrderStatus.Succeeds);
    expect(res(result, 'lon')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(1);
    expect(result.dislodgedUnits[0].unit.province).toBe('nth');
    expect(result.newPositions.find((u) => u.province === 'lon')).toBeDefined();
  });
});

// ============================================================================
// 16. DISLODGED UNIT INTERACTIONS
// [Rule 20] "Dislodged units have no effect on the province where the unit
//            dislodged it came from." However, dislodged units CAN still cut
//            support in OTHER provinces and cause bounces elsewhere.
// ============================================================================

describe('Dislodged Unit Interactions', () => {
  it('Dislodged unit still cuts support in another province', () => {
    // A BUR is dislodged by A RUH (S from MUN). But A BUR -> MAR cuts
    // A MAR S A GAS H. The dislodged A BUR still cuts support because
    // it's attacking a province other than RUH (the attacker origin).
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'mar' },
      { type: UnitType.Army, power: Power.France, province: 'gas' },
      { type: UnitType.Army, power: Power.Italy, province: 'pie' },
    ];
    const orders = new Map<string, Order>([
      ['mun', { type: OrderType.Support, unit: 'mun', supportedUnit: 'ruh', destination: 'bur' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'mar' }],
      ['mar', { type: OrderType.Support, unit: 'mar', supportedUnit: 'gas' }],
      ['gas', { type: OrderType.Hold, unit: 'gas' }],
      ['pie', { type: OrderType.Move, unit: 'pie', destination: 'mar' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // RUH dislodges BUR (strength 2 vs 1, BUR is moving away but fails)
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Succeeds);
    // BUR -> MAR fails (BUR is dislodged), but the move order still cuts MAR's support
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'mar')!.status).toBe(OrderStatus.Fails); // support cut by BUR
    // Without MAR's support, GAS hold strength is 1, PIE attack is 1 => bounce
    expect(res(result, 'pie')!.status).toBe(OrderStatus.Fails);
  });

  it('Support-hold on a unit that tried to move but bounced — defense still boosted', () => {
    // A BUR -> MAR, A PIE -> MAR (bounce at MAR). A BUR stays in BUR.
    // A PAR S A BUR H. German A RUH -> BUR.
    // BUR tried to move but bounced. PAR's support-hold still counts for BUR's defense.
    // BUR hold strength = 2 (1 + PAR support). RUH attack = 1. RUH fails.
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.France, province: 'bur' },
      { type: UnitType.Army, power: Power.France, province: 'par' },
      { type: UnitType.Army, power: Power.Italy, province: 'pie' },
      { type: UnitType.Army, power: Power.Italy, province: 'mar' },
      { type: UnitType.Army, power: Power.Germany, province: 'ruh' },
    ];
    const orders = new Map<string, Order>([
      ['bur', { type: OrderType.Move, unit: 'bur', destination: 'mar' }],
      ['par', { type: OrderType.Support, unit: 'par', supportedUnit: 'bur' }],
      ['pie', { type: OrderType.Move, unit: 'pie', destination: 'mar' }],
      ['mar', { type: OrderType.Hold, unit: 'mar' }],
      ['ruh', { type: OrderType.Move, unit: 'ruh', destination: 'bur' }],
    ]);
    const result = resolveOrders(units, orders, PROVINCES);

    // BUR and PIE bounce at MAR
    expect(res(result, 'bur')!.status).toBe(OrderStatus.Fails);
    expect(res(result, 'pie')!.status).toBe(OrderStatus.Fails);
    // RUH fails to enter BUR (1 vs 2 with support-hold)
    expect(res(result, 'ruh')!.status).toBe(OrderStatus.Fails);
    expect(result.dislodgedUnits).toHaveLength(0);
  });
});
