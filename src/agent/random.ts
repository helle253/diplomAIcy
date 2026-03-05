import {
  Power,
  GameState,
  Message,
  Order,
  OrderType,
  RetreatOrder,
  BuildOrder,
  RetreatSituation,
  UnitType,
  Unit,
  ProvinceType,
  Coast,
} from '../engine/types.js';
import { PROVINCES } from '../engine/map.js';
import { DiplomacyAgent } from './interface.js';

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export class RandomAgent implements DiplomacyAgent {
  power: Power;

  constructor(power: Power) {
    this.power = power;
  }

  async initialize(_gameState: GameState): Promise<void> {
    // No-op
  }

  async negotiate(gameState: GameState, _incomingMessages: Message[]): Promise<Message[]> {
    // Generate random diplomatic chatter for demo purposes
    if (Math.random() < 0.3) return []; // sometimes say nothing

    const otherPowers = [
      Power.England, Power.France, Power.Germany, Power.Italy,
      Power.Austria, Power.Russia, Power.Turkey,
    ].filter(p => p !== this.power);

    const templates = [
      `I propose we work together this turn.`,
      `Let's coordinate our moves against our mutual enemies.`,
      `I have no hostile intentions toward you.`,
      `Can we agree to a ceasefire?`,
      `I'm planning to move east - stay out of my way.`,
      `I'll support your position if you support mine.`,
      `Watch out - I think you're about to be attacked.`,
      `Let's form an alliance against the strongest power.`,
      `I need your help. Can we talk?`,
      `I'm willing to offer a non-aggression pact.`,
      `Don't trust what the others are telling you.`,
      `I'll leave your borders alone if you leave mine alone.`,
    ];

    const messages: Message[] = [];
    const numMessages = Math.random() < 0.5 ? 1 : 2;

    for (let i = 0; i < numMessages; i++) {
      const isGlobal = Math.random() < 0.15;
      messages.push({
        from: this.power,
        to: isGlobal ? 'Global' : pickRandom(otherPowers),
        content: pickRandom(templates),
        phase: gameState.phase,
        timestamp: Date.now(),
      });
    }

    return messages;
  }

  async submitOrders(gameState: GameState): Promise<Order[]> {
    const myUnits = gameState.units.filter((u) => u.power === this.power);
    const orders: Order[] = [];

    for (const unit of myUnits) {
      const province = PROVINCES[unit.province];
      if (!province) {
        orders.push({ type: OrderType.Hold, unit: unit.province });
        continue;
      }

      // Get valid adjacent provinces for this unit type
      const adjacentProvs = this.getAdjacentProvinces(unit);

      // Build list of possible orders
      const possibleOrders: Order[] = [];

      // Hold is always valid
      possibleOrders.push({ type: OrderType.Hold, unit: unit.province });

      // Move to each valid adjacent province
      for (const dest of adjacentProvs) {
        const destProv = PROVINCES[dest];
        if (!destProv) continue;

        // Armies cannot enter sea provinces
        if (unit.type === UnitType.Army && destProv.type === ProvinceType.Sea) continue;
        // Fleets cannot enter inland provinces
        if (unit.type === UnitType.Fleet && destProv.type === ProvinceType.Land) continue;

        // Handle multi-coast destinations for fleets
        if (unit.type === UnitType.Fleet && destProv.coasts && destProv.coasts.length > 0) {
          // Fleet must specify which coast to move to
          for (const coast of destProv.coasts) {
            // Check that the fleet can actually reach this specific coast
            const coastAdj = destProv.adjacency.fleetByCoast?.[coast];
            if (coastAdj && coastAdj.includes(unit.province)) {
              possibleOrders.push({
                type: OrderType.Move,
                unit: unit.province,
                destination: dest,
                coast,
              });
            }
          }
        } else {
          possibleOrders.push({
            type: OrderType.Move,
            unit: unit.province,
            destination: dest,
          });
        }
      }

      // Support-hold for a neighboring friendly unit
      for (const adj of adjacentProvs) {
        const friendlyUnit = myUnits.find((u) => u.province === adj);
        if (friendlyUnit) {
          possibleOrders.push({
            type: OrderType.Support,
            unit: unit.province,
            supportedUnit: adj,
            // No destination = support-hold
          });
        }
      }

      orders.push(pickRandom(possibleOrders));
    }

    return orders;
  }

  async submitRetreats(
    _gameState: GameState,
    retreatSituations: RetreatSituation[]
  ): Promise<RetreatOrder[]> {
    const orders: RetreatOrder[] = [];

    for (const situation of retreatSituations) {
      if (situation.unit.power !== this.power) continue;

      if (situation.validDestinations.length > 0) {
        const dest = pickRandom(situation.validDestinations);
        const destProv = PROVINCES[dest];

        // Handle multi-coast retreat destinations for fleets
        let coast: Coast | undefined;
        if (
          situation.unit.type === UnitType.Fleet &&
          destProv?.coasts &&
          destProv.coasts.length > 0
        ) {
          // Pick a coast that is reachable from the unit's current province
          const reachableCoasts = destProv.coasts.filter((c) => {
            const coastAdj = destProv.adjacency.fleetByCoast?.[c];
            return coastAdj && coastAdj.includes(situation.unit.province);
          });
          if (reachableCoasts.length > 0) {
            coast = pickRandom(reachableCoasts);
          }
        }

        orders.push({
          type: 'RetreatMove',
          unit: situation.unit.province,
          destination: dest,
          coast,
        });
      } else {
        orders.push({
          type: 'Disband',
          unit: situation.unit.province,
        });
      }
    }

    return orders;
  }

  async submitBuilds(gameState: GameState, buildCount: number): Promise<BuildOrder[]> {
    const orders: BuildOrder[] = [];

    if (buildCount > 0) {
      // Build units on unoccupied home supply centers
      const occupiedProvinces = new Set(gameState.units.map((u) => u.province));
      const homeCenters = Object.values(PROVINCES).filter(
        (p) => p.homeCenter === this.power && p.supplyCenter
      );
      const availableCenters = homeCenters.filter((p) => !occupiedProvinces.has(p.id));

      let buildsRemaining = buildCount;
      const centersToUse = [...availableCenters];

      while (buildsRemaining > 0 && centersToUse.length > 0) {
        const idx = Math.floor(Math.random() * centersToUse.length);
        const center = centersToUse.splice(idx, 1)[0];

        if (center.type === ProvinceType.Land) {
          // Inland: can only build armies
          orders.push({
            type: 'Build',
            unitType: UnitType.Army,
            province: center.id,
          });
        } else if (center.type === ProvinceType.Coastal) {
          // Coastal: can build army or fleet
          const unitType = Math.random() < 0.5 ? UnitType.Army : UnitType.Fleet;

          if (unitType === UnitType.Fleet && center.coasts && center.coasts.length > 0) {
            // Multi-coast province: pick a random coast
            orders.push({
              type: 'Build',
              unitType: UnitType.Fleet,
              province: center.id,
              coast: pickRandom(center.coasts),
            });
          } else {
            orders.push({
              type: 'Build',
              unitType,
              province: center.id,
            });
          }
        }

        buildsRemaining--;
      }

      // Waive any remaining builds we can't place
      while (buildsRemaining > 0) {
        orders.push({ type: 'Waive' });
        buildsRemaining--;
      }
    } else if (buildCount < 0) {
      // Must disband units
      const myUnits = [...gameState.units.filter((u) => u.power === this.power)];
      let removalsRemaining = Math.abs(buildCount);

      while (removalsRemaining > 0 && myUnits.length > 0) {
        const idx = Math.floor(Math.random() * myUnits.length);
        const unit = myUnits.splice(idx, 1)[0];
        orders.push({
          type: 'Remove',
          unit: unit.province,
        });
        removalsRemaining--;
      }
    }

    return orders;
  }

  /**
   * Get valid adjacent provinces for a unit, handling multi-coast fleet movement.
   */
  private getAdjacentProvinces(unit: Unit): string[] {
    const province = PROVINCES[unit.province];
    if (!province) return [];

    if (unit.type === UnitType.Army) {
      return province.adjacency.army;
    }

    // Fleet: check if on a multi-coast province
    if (unit.coast && province.adjacency.fleetByCoast) {
      const coastAdj = province.adjacency.fleetByCoast[unit.coast];
      return coastAdj ?? [];
    }

    return province.adjacency.fleet;
  }
}
