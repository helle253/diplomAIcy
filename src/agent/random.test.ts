import { describe, expect, it } from 'vitest';

import { PROVINCES, STARTING_SUPPLY_CENTERS, STARTING_UNITS } from '../engine/map.js';
import {
  Coast,
  GameState,
  Message,
  OrderType,
  PhaseType,
  Power,
  ProvinceType,
  RetreatSituation,
  Season,
  Unit,
  UnitType,
} from '../engine/types.js';
import { RandomAgent } from './random.js';

// ============================================================================
// Helper: create a minimal GameState
// ============================================================================
function makeGameState(units: Unit[], supplyCenters?: Map<string, Power>): GameState {
  return {
    phase: { year: 1901, season: Season.Spring, type: PhaseType.Orders },
    units,
    supplyCenters: supplyCenters ?? new Map(STARTING_SUPPLY_CENTERS),
    orderHistory: [],
    retreatSituations: [],
  };
}

// ============================================================================
// 1. INITIALIZATION & NEGOTIATION
// ============================================================================

describe('RandomAgent — initialize & negotiate', () => {
  it('initialize is a no-op that resolves', async () => {
    const agent = new RandomAgent(Power.Germany);
    await expect(agent.initialize(makeGameState(STARTING_UNITS))).resolves.toBeUndefined();
  });

  it('openNegotiation returns valid messages', async () => {
    const agent = new RandomAgent(Power.Germany);
    const messages = await agent.openNegotiation(makeGameState(STARTING_UNITS));
    expect(messages).toBeInstanceOf(Array);
    for (const msg of messages) {
      expect(msg.from).toBe(Power.Germany);
      expect(typeof msg.content).toBe('string');
    }
  });

  it('onMessage returns valid reply messages', async () => {
    const agent = new RandomAgent(Power.Germany);
    const gs = makeGameState(STARTING_UNITS);
    const incoming: Message = {
      from: Power.France,
      to: Power.Germany,
      content: 'Hello!',
      phase: gs.phase,
      timestamp: Date.now(),
    };
    const replies = await agent.onMessage(incoming, gs);
    expect(replies).toBeInstanceOf(Array);
    for (const msg of replies) {
      expect(msg.from).toBe(Power.Germany);
      expect(msg.to).toBe(Power.France);
    }
  });

  it('power is set correctly', () => {
    const agent = new RandomAgent(Power.France);
    expect(agent.power).toBe(Power.France);
  });
});

// ============================================================================
// 2. SUBMIT ORDERS
// Verify that RandomAgent only produces valid orders for its own units.
// ============================================================================

describe('RandomAgent — submitOrders', () => {
  it('returns one order per owned unit', async () => {
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(STARTING_UNITS);
    const orders = await agent.submitOrders(state);

    // Germany starts with 3 units
    expect(orders).toHaveLength(3);
  });

  it("only generates orders for its own power's units", async () => {
    const agent = new RandomAgent(Power.England);
    const state = makeGameState(STARTING_UNITS);
    const orders = await agent.submitOrders(state);

    // Every order should reference an English unit's province
    const englishProvs = STARTING_UNITS.filter((u) => u.power === Power.England).map(
      (u) => u.province,
    );

    for (const order of orders) {
      expect(englishProvs).toContain(order.unit);
    }
  });

  it('all generated orders are valid types (Hold, Move, or Support)', async () => {
    const agent = new RandomAgent(Power.France);
    const state = makeGameState(STARTING_UNITS);

    // Run multiple times to cover randomness
    for (let i = 0; i < 20; i++) {
      const orders = await agent.submitOrders(state);
      for (const order of orders) {
        expect([OrderType.Hold, OrderType.Move, OrderType.Support]).toContain(order.type);
      }
    }
  });

  it('Move orders go to valid adjacent provinces', async () => {
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(STARTING_UNITS);

    for (let i = 0; i < 30; i++) {
      const orders = await agent.submitOrders(state);
      for (const order of orders) {
        if (order.type !== OrderType.Move) continue;
        const unit = STARTING_UNITS.find((u) => u.province === order.unit)!;
        const prov = PROVINCES[order.unit];

        // Destination must be in the unit's adjacency list
        if (unit.type === UnitType.Army) {
          expect(prov.adjacency.army).toContain(order.destination);
        } else if (unit.coast && prov.adjacency.fleetByCoast) {
          // Fleet on a specific coast uses fleetByCoast adjacency
          const coastAdj = prov.adjacency.fleetByCoast[unit.coast];
          expect(coastAdj).toContain(order.destination);
        } else {
          expect(prov.adjacency.fleet).toContain(order.destination);
        }

        // Destination province type must be compatible
        const destProv = PROVINCES[order.destination];
        if (unit.type === UnitType.Army) {
          expect(destProv.type).not.toBe(ProvinceType.Sea);
        }
        if (unit.type === UnitType.Fleet) {
          expect(destProv.type).not.toBe(ProvinceType.Land);
        }
      }
    }
  });

  it('Support orders reference friendly units at adjacent provinces', async () => {
    const agent = new RandomAgent(Power.Austria);
    // Austria starts with: F tri, A vie, A bud — all adjacent to each other
    const state = makeGameState(STARTING_UNITS);

    for (let i = 0; i < 30; i++) {
      const orders = await agent.submitOrders(state);
      for (const order of orders) {
        if (order.type !== OrderType.Support) continue;
        // It's a support-hold (no destination in random agent)
        expect(order.destination).toBeUndefined();

        // The supported unit must be a friendly unit
        const supportedUnit = STARTING_UNITS.find(
          (u) => u.province === order.supportedUnit && u.power === Power.Austria,
        );
        expect(supportedUnit).toBeDefined();

        // The supported unit must be adjacent to the supporting unit
        const supporterProv = PROVINCES[order.unit];
        const unitObj = STARTING_UNITS.find((u) => u.province === order.unit)!;
        if (unitObj.type === UnitType.Army) {
          expect(supporterProv.adjacency.army).toContain(order.supportedUnit);
        } else {
          expect(supporterProv.adjacency.fleet).toContain(order.supportedUnit);
        }
      }
    }
  });

  it('Fleet on multi-coast province uses correct coast adjacency', async () => {
    // Russia's F stp(sc) should only produce moves to stp south coast adjacencies
    const agent = new RandomAgent(Power.Russia);
    const state = makeGameState(STARTING_UNITS);
    const stpScAdj = PROVINCES['stp'].adjacency.fleetByCoast![Coast.South]!;

    for (let i = 0; i < 30; i++) {
      const orders = await agent.submitOrders(state);
      const stpOrder = orders.find((o) => o.unit === 'stp');
      if (stpOrder && stpOrder.type === OrderType.Move) {
        expect(stpScAdj).toContain(stpOrder.destination);
      }
    }
  });

  it('Move to multi-coast destination specifies a coast for fleets', async () => {
    // Place a fleet adjacent to Spain to test coast selection
    const units: Unit[] = [{ type: UnitType.Fleet, power: Power.France, province: 'mao' }];
    const agent = new RandomAgent(Power.France);
    const state = makeGameState(units);

    for (let i = 0; i < 30; i++) {
      const orders = await agent.submitOrders(state);
      for (const order of orders) {
        if (order.type === OrderType.Move && order.destination === 'spa') {
          // Must specify a coast when moving fleet to Spain
          expect(order.coast).toBeDefined();
          expect([Coast.North, Coast.South]).toContain(order.coast);
        }
      }
    }
  });

  it('returns Hold for unit in unknown province', async () => {
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'xxx' }];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);
    const orders = await agent.submitOrders(state);

    expect(orders).toHaveLength(1);
    expect(orders[0].type).toBe(OrderType.Hold);
  });

  it('handles empty unit list', async () => {
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState([]);
    const orders = await agent.submitOrders(state);
    expect(orders).toHaveLength(0);
  });
});

// ============================================================================
// 3. SUBMIT RETREATS
// ============================================================================

describe('RandomAgent — submitRetreats', () => {
  it('retreats to a valid destination when options exist', async () => {
    const agent = new RandomAgent(Power.France);
    const situation: RetreatSituation = {
      unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
      attackedFrom: 'ruh',
      validDestinations: ['mar', 'gas', 'par'],
    };
    const state = makeGameState([]);

    for (let i = 0; i < 20; i++) {
      const orders = await agent.submitRetreats(state, [situation]);
      expect(orders).toHaveLength(1);
      expect(orders[0].type).toBe('RetreatMove');
      if (orders[0].type === 'RetreatMove') {
        expect(['mar', 'gas', 'par']).toContain(orders[0].destination);
      }
    }
  });

  it('disbands when no valid destinations exist', async () => {
    const agent = new RandomAgent(Power.France);
    const situation: RetreatSituation = {
      unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
      attackedFrom: 'ruh',
      validDestinations: [],
    };
    const state = makeGameState([]);
    const orders = await agent.submitRetreats(state, [situation]);

    expect(orders).toHaveLength(1);
    expect(orders[0].type).toBe('Disband');
    expect(orders[0].unit).toBe('bur');
  });

  it('only processes retreat situations for its own power', async () => {
    const agent = new RandomAgent(Power.France);
    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'ruh',
        validDestinations: ['mar'],
      },
      {
        unit: { type: UnitType.Army, power: Power.Germany, province: 'mun' },
        attackedFrom: 'boh',
        validDestinations: ['ber'],
      },
    ];
    const state = makeGameState([]);
    const orders = await agent.submitRetreats(state, situations);

    // Should only handle France's retreat, not Germany's
    expect(orders).toHaveLength(1);
    expect(orders[0].unit).toBe('bur');
  });

  it('handles multiple retreats for same power', async () => {
    const agent = new RandomAgent(Power.France);
    const situations: RetreatSituation[] = [
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'bur' },
        attackedFrom: 'ruh',
        validDestinations: ['mar'],
      },
      {
        unit: { type: UnitType.Army, power: Power.France, province: 'pic' },
        attackedFrom: 'bel',
        validDestinations: ['par'],
      },
    ];
    const state = makeGameState([]);
    const orders = await agent.submitRetreats(state, situations);

    expect(orders).toHaveLength(2);
  });

  it('handles empty retreat situations', async () => {
    const agent = new RandomAgent(Power.France);
    const state = makeGameState([]);
    const orders = await agent.submitRetreats(state, []);
    expect(orders).toHaveLength(0);
  });
});

// ============================================================================
// 4. SUBMIT BUILDS
// ============================================================================

describe('RandomAgent — submitBuilds', () => {
  it('builds units on unoccupied home supply centers (buildCount > 0)', async () => {
    // Germany has no units, 3 home centers available
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState([]);

    for (let i = 0; i < 20; i++) {
      const orders = await agent.submitBuilds(state, 2);
      expect(orders).toHaveLength(2);
      for (const order of orders) {
        expect(order.type).toBe('Build');
        if (order.type === 'Build') {
          // Must be on a German home supply center
          const prov = PROVINCES[order.province];
          expect(prov.homeCenter).toBe(Power.Germany);
          expect(prov.supplyCenter).toBe(true);
        }
      }
    }
  });

  it('builds only armies on inland home centers', async () => {
    // Munich is inland — can only build armies
    // Clear ber and kie so only mun is available
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
    ];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);

    for (let i = 0; i < 10; i++) {
      const orders = await agent.submitBuilds(state, 1);
      expect(orders).toHaveLength(1);
      if (orders[0].type === 'Build') {
        expect(orders[0].province).toBe('mun');
        expect(orders[0].unitType).toBe(UnitType.Army);
      }
    }
  });

  it('can build army or fleet on coastal home centers', async () => {
    // Berlin is coastal — can build either
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
    ];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);

    const unitTypes = new Set<UnitType>();
    for (let i = 0; i < 50; i++) {
      const orders = await agent.submitBuilds(state, 1);
      if (orders[0].type === 'Build') {
        expect(orders[0].province).toBe('ber');
        unitTypes.add(orders[0].unitType);
      }
    }
    // Over 50 runs, should have seen both armies and fleets
    expect(unitTypes.has(UnitType.Army)).toBe(true);
    expect(unitTypes.has(UnitType.Fleet)).toBe(true);
  });

  it('waives when no home centers are available', async () => {
    // All German home centers occupied
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
    ];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);
    const orders = await agent.submitBuilds(state, 1);

    expect(orders).toHaveLength(1);
    expect(orders[0].type).toBe('Waive');
  });

  it('removes units when buildCount < 0', async () => {
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
    ];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);

    for (let i = 0; i < 10; i++) {
      const orders = await agent.submitBuilds(state, -1);
      expect(orders).toHaveLength(1);
      expect(orders[0].type).toBe('Remove');
      if (orders[0].type === 'Remove') {
        expect(['ber', 'kie', 'mun']).toContain(orders[0].unit);
      }
    }
  });

  it('removes multiple units when buildCount is very negative', async () => {
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
      { type: UnitType.Army, power: Power.Germany, province: 'mun' },
    ];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);
    const orders = await agent.submitBuilds(state, -2);

    expect(orders).toHaveLength(2);
    orders.forEach((o) => expect(o.type).toBe('Remove'));
    // Should be different units
    if (orders[0].type === 'Remove' && orders[1].type === 'Remove') {
      expect(orders[0].unit).not.toBe(orders[1].unit);
    }
  });

  it('returns empty when buildCount is 0', async () => {
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(STARTING_UNITS);
    const orders = await agent.submitBuilds(state, 0);
    expect(orders).toHaveLength(0);
  });

  it('does not build on occupied home centers', async () => {
    // ber is occupied, so builds should go to kie or mun
    const units: Unit[] = [{ type: UnitType.Army, power: Power.Germany, province: 'ber' }];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);

    for (let i = 0; i < 20; i++) {
      const orders = await agent.submitBuilds(state, 1);
      expect(orders).toHaveLength(1);
      if (orders[0].type === 'Build') {
        expect(orders[0].province).not.toBe('ber');
        expect(['kie', 'mun']).toContain(orders[0].province);
      }
    }
  });

  it('partial waive when fewer centers than builds requested', async () => {
    // Only 1 home center available, but 2 builds requested
    const units: Unit[] = [
      { type: UnitType.Army, power: Power.Germany, province: 'ber' },
      { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
    ];
    const agent = new RandomAgent(Power.Germany);
    const state = makeGameState(units);
    const orders = await agent.submitBuilds(state, 2);

    expect(orders).toHaveLength(2);
    const builds = orders.filter((o) => o.type === 'Build');
    const waives = orders.filter((o) => o.type === 'Waive');
    expect(builds).toHaveLength(1);
    expect(waives).toHaveLength(1);
    if (builds[0].type === 'Build') {
      expect(builds[0].province).toBe('mun');
    }
  });
});

// ============================================================================
// 5. INTEGRATION — all 7 powers can generate valid orders from starting position
// ============================================================================

describe('RandomAgent — all powers from starting position', () => {
  const allPowers = [
    Power.England,
    Power.France,
    Power.Germany,
    Power.Italy,
    Power.Austria,
    Power.Russia,
    Power.Turkey,
  ];

  for (const power of allPowers) {
    it(`${power} generates valid orders from starting position`, async () => {
      const agent = new RandomAgent(power);
      const state = makeGameState(STARTING_UNITS);
      const orders = await agent.submitOrders(state);

      const unitCount = STARTING_UNITS.filter((u) => u.power === power).length;
      expect(orders).toHaveLength(unitCount);

      for (const order of orders) {
        // Every order unit should be one of this power's provinces
        const unit = STARTING_UNITS.find((u) => u.province === order.unit && u.power === power);
        expect(unit).toBeDefined();

        if (order.type === OrderType.Move) {
          const prov = PROVINCES[order.unit];
          const destProv = PROVINCES[order.destination];
          expect(destProv).toBeDefined();

          if (unit!.type === UnitType.Army) {
            expect(prov.adjacency.army).toContain(order.destination);
            expect(destProv.type).not.toBe(ProvinceType.Sea);
          }
        }
      }
    });
  }
});
