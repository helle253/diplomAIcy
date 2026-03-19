import { PROVINCES } from '../../engine/map';
import { Coast, GameState, Power, ProvinceType, UnitType } from '../../engine/types';

export interface ValidationResult {
  valid: boolean;
  error?: string;
  reachable?: string[];
}

/**
 * Get reachable provinces for a unit at a given province.
 */
export function getReachableProvinces(
  province: string,
  unitType: UnitType,
  coast?: Coast,
): string[] {
  const prov = PROVINCES[province];
  if (!prov) return [];

  if (unitType === UnitType.Army) {
    return prov.adjacency.army;
  }

  if (coast && prov.adjacency.fleetByCoast?.[coast]) {
    return prov.adjacency.fleetByCoast[coast]!;
  }

  return prov.adjacency.fleet ?? [];
}

/**
 * Validate a Move order: destination must be adjacent and reachable by this unit type.
 */
export function validateMoveOrder(
  unitProvince: string,
  unitType: UnitType,
  destination: string,
  coast?: Coast,
  unitCoast?: Coast,
): ValidationResult {
  const destProv = PROVINCES[destination];
  if (!destProv) {
    return { valid: false, error: `Unknown province: ${destination}` };
  }

  // Army cannot enter sea
  if (unitType === UnitType.Army && destProv.type === ProvinceType.Sea) {
    return {
      valid: false,
      error: `${unitProvince} [Army] cannot move to sea province ${destination}`,
      reachable: getReachableProvinces(unitProvince, unitType, unitCoast),
    };
  }

  // Fleet cannot enter land
  if (unitType === UnitType.Fleet && destProv.type === ProvinceType.Land) {
    return {
      valid: false,
      error: `${unitProvince} [Fleet] cannot move to land province ${destination}`,
      reachable: getReachableProvinces(unitProvince, unitType, unitCoast),
    };
  }

  // Check adjacency
  const reachable = getReachableProvinces(unitProvince, unitType, unitCoast);
  if (!reachable.includes(destination)) {
    return {
      valid: false,
      error: `${destination} is not reachable from ${unitProvince}. Reachable: ${reachable.join(', ')}`,
      reachable,
    };
  }

  // Fleet moving to multi-coast province must specify coast
  if (unitType === UnitType.Fleet && destProv.coasts && destProv.coasts.length > 1 && !coast) {
    return {
      valid: false,
      error: `${destination} has multiple coasts. Specify coast: ${destProv.coasts.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Validate a Support order: supporting unit must be adjacent to the destination.
 */
export function validateSupportOrder(
  unitProvince: string,
  unitType: UnitType,
  supportedUnit: string,
  destination: string | undefined,
  units: GameState['units'],
  unitCoast?: Coast,
): ValidationResult {
  // Supported unit must exist
  const supported = units.find((u) => u.province === supportedUnit);
  if (!supported) {
    return { valid: false, error: `No unit at ${supportedUnit} to support` };
  }

  // For support-move: supporting unit must be able to reach the destination
  // For support-hold: supporting unit must be adjacent to the supported unit
  const target = destination ?? supportedUnit;
  const reachable = getReachableProvinces(unitProvince, unitType, unitCoast);
  if (!reachable.includes(target)) {
    return {
      valid: false,
      error: `${unitProvince} cannot support into ${target}. Reachable: ${reachable.join(', ')}`,
      reachable,
    };
  }

  return { valid: true };
}

/**
 * Validate a Convoy order: must be a fleet in a sea province.
 */
export function validateConvoyOrder(
  unitProvince: string,
  unitType: UnitType,
  convoyedUnit: string,
  units: GameState['units'],
): ValidationResult {
  if (unitType !== UnitType.Fleet) {
    return { valid: false, error: `${unitProvince} is not a Fleet — only Fleets can convoy` };
  }

  const prov = PROVINCES[unitProvince];
  if (prov && prov.type !== ProvinceType.Sea) {
    return { valid: false, error: `${unitProvince} is not a sea province — convoys require sea` };
  }

  const convoyed = units.find((u) => u.province === convoyedUnit);
  if (!convoyed) {
    return { valid: false, error: `No unit at ${convoyedUnit} to convoy` };
  }
  if (convoyed.type !== UnitType.Army) {
    return {
      valid: false,
      error: `Unit at ${convoyedUnit} is a Fleet — only Armies can be convoyed`,
    };
  }

  return { valid: true };
}

/**
 * Validate a retreat order against the retreat situations.
 */
export function validateRetreatOrder(
  unitProvince: string,
  destination: string | undefined,
  gameState: GameState,
  power: Power,
): ValidationResult {
  const situation = gameState.retreatSituations.find(
    (s) => s.unit.province === unitProvince && s.unit.power === power,
  );
  if (!situation) {
    return { valid: false, error: `No dislodged unit at ${unitProvince}` };
  }

  if (destination) {
    if (!situation.validDestinations.includes(destination)) {
      return {
        valid: false,
        error: `${unitProvince} cannot retreat to ${destination}. Valid: ${situation.validDestinations.join(', ')}`,
        reachable: situation.validDestinations,
      };
    }
  }

  return { valid: true };
}

/**
 * Validate a build order.
 */
export function validateBuildOrder(
  type: string,
  province: string | undefined,
  gameState: GameState,
  power: Power,
): ValidationResult {
  if (type === 'Waive') return { valid: true };

  if (type === 'Build') {
    if (!province) return { valid: false, error: 'Build requires a province' };
    const prov = PROVINCES[province];
    if (!prov) return { valid: false, error: `Unknown province: ${province}` };
    if (prov.homeCenter !== power) {
      return { valid: false, error: `${province} is not your home center` };
    }
    if (!prov.supplyCenter) {
      return { valid: false, error: `${province} is not a supply center` };
    }
    if (gameState.supplyCenters.get(province) !== power) {
      return { valid: false, error: `You do not control ${province}` };
    }
    if (gameState.units.some((u) => u.province === province)) {
      return { valid: false, error: `${province} is occupied — cannot build there` };
    }
    return { valid: true };
  }

  if (type === 'Remove') {
    if (!province) return { valid: false, error: 'Remove requires a province (unit field)' };
    const unit = gameState.units.find((u) => u.province === province && u.power === power);
    if (!unit) {
      return { valid: false, error: `No unit of yours at ${province} to remove` };
    }
    return { valid: true };
  }

  return { valid: false, error: `Unknown build type: ${type}` };
}
