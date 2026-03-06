import type {
  GameState,
  OrderResolution,
  Phase,
  Power,
  RetreatSituation,
  Unit,
} from '../../engine/types.js';

/** The wire format returned by the tRPC router (supplyCenters as plain object). */
export interface SerializedGameState {
  phase: Phase;
  units: Unit[];
  supplyCenters: Record<string, Power>;
  orderHistory: OrderResolution[][];
  retreatSituations: RetreatSituation[];
  deadlineMs: number;
}

/** Converts the serialized tRPC game state back into a proper GameState with Map. */
export function deserializeGameState(s: SerializedGameState): GameState {
  return {
    phase: s.phase,
    units: s.units,
    supplyCenters: new Map(Object.entries(s.supplyCenters)) as Map<string, Power>,
    orderHistory: s.orderHistory,
    retreatSituations: s.retreatSituations,
  };
}
