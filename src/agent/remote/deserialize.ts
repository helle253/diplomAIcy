import type {
  GameState,
  OrderResolution,
  Phase,
  Power,
  ProvinceState,
  RetreatSituation,
  Unit,
} from '../../engine/types.js';
import { UnitType } from '../../engine/types.js';

/** The wire format returned by the tRPC router (unified map state). */
export interface SerializedGameState {
  phase: Phase;
  map: Record<string, ProvinceState>;
  orderHistory: OrderResolution[][];
  retreatSituations: RetreatSituation[];
  endYear: number;
  deadlineMs: number;
  gameOver?: boolean;
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
    orderHistory: s.orderHistory,
    retreatSituations: s.retreatSituations,
    endYear: s.endYear,
  };
}
