import { PROVINCES } from './map';
import type { Power, ProvinceState, Unit } from './types';

export function buildMapState(
  units: Unit[],
  supplyCenters: Map<string, Power>,
): Record<string, ProvinceState> {
  const unitByProvince = new Map<string, Unit>();
  for (const u of units) {
    unitByProvince.set(u.province, u);
  }

  const result: Record<string, ProvinceState> = {};

  for (const [id, prov] of Object.entries(PROVINCES)) {
    // Union adjacency: army + fleet + all fleetByCoast values
    const adjSet = new Set<string>([...prov.adjacency.army, ...prov.adjacency.fleet]);
    if (prov.adjacency.fleetByCoast) {
      for (const coastAdj of Object.values(prov.adjacency.fleetByCoast)) {
        if (coastAdj) {
          for (const p of coastAdj) adjSet.add(p);
        }
      }
    }

    // Coast-specific adjacency for multi-coast provinces
    let coasts: Record<string, string[]> | null = null;
    if (prov.adjacency.fleetByCoast) {
      coasts = {};
      for (const [coast, adj] of Object.entries(prov.adjacency.fleetByCoast)) {
        if (adj) coasts[coast] = [...adj];
      }
    }

    const unit = unitByProvince.get(id);
    const owner = supplyCenters.get(id) ?? null;

    result[id] = {
      name: prov.name,
      type: prov.type,
      supplyCenter: prov.supplyCenter,
      homeCenter: prov.homeCenter ?? null,
      adjacent: [...adjSet],
      coasts,
      owner: prov.supplyCenter ? owner : null,
      unit: unit ? { type: unit.type, power: unit.power, coast: unit.coast ?? null } : null,
    };
  }

  return result;
}
