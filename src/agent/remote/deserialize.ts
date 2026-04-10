import type {
  GameState,
  OrderResolution,
  Phase,
  Power,
  ProvinceState,
  RetreatSituation,
  Unit,
} from '../../engine/types';
import { UnitType } from '../../engine/types';

/** Per-power order round in wire format, with phase label. */
export interface WireOrderRound {
  phase: Phase;
  orders: OrderResolution[];
}

/** The wire format returned by the tRPC router (unified map state). */
export interface SerializedGameState {
  phase: Phase;
  availableActions?: string[];
  map: Record<string, ProvinceState>;
  orderHistory: Record<string, WireOrderRound[]>;
  retreatSituations: RetreatSituation[];
  endYear?: number;
  deadlineMs: number;
  gameOver?: boolean;
}

/** Reconstructs flat OrderResolution[][] from per-power wire format. */
function deserializeOrderHistory(perPower: Record<string, WireOrderRound[]>): OrderResolution[][] {
  // Find the max number of rounds across all powers
  let maxRounds = 0;
  for (const rounds of Object.values(perPower)) {
    if (rounds.length > maxRounds) maxRounds = rounds.length;
  }
  // Merge each round back together
  const result: OrderResolution[][] = [];
  for (let i = 0; i < maxRounds; i++) {
    const round: OrderResolution[] = [];
    for (const rounds of Object.values(perPower)) {
      if (i < rounds.length) {
        round.push(...rounds[i].orders);
      }
    }
    result.push(round);
  }
  return result;
}

/** Converts the serialized tRPC game state back into internal GameState. */
export function deserializeGameState(s: SerializedGameState): GameState {
  const units: Unit[] = [];
  const supplyCenters = new Map<string, Power>();

  for (const [id, prov] of Object.entries(s.map)) {
    if (prov.unit) {
      units.push({
        type: prov.unit.type as UnitType,
        power: prov.unit.power as Power,
        province: id,
        coast: (prov.unit.coast as Unit['coast']) ?? undefined,
      });
    }
    if (prov.owner) {
      supplyCenters.set(id, prov.owner as Power);
    }
  }

  return {
    phase: s.phase,
    units,
    supplyCenters,
    orderHistory: deserializeOrderHistory(s.orderHistory),
    retreatSituations: s.retreatSituations,
    endYear: s.endYear,
  };
}
