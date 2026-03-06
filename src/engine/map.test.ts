import { describe, expect, it } from 'vitest';

import { PROVINCES, STARTING_SUPPLY_CENTERS, STARTING_UNITS } from './map.js';
import { Coast, Power, ProvinceType, UnitType } from './types.js';

// ============================================================================
// Structural Validation
// ============================================================================

describe('Structural Validation', () => {
  const provinceIds = Object.keys(PROVINCES);

  it('should have exactly 75 provinces', () => {
    expect(provinceIds.length).toBe(75);
  });

  it('should have 14 inland (Land) provinces', () => {
    const inland = provinceIds.filter((id) => PROVINCES[id].type === ProvinceType.Land);
    expect(inland.length).toBe(14);
  });

  it('should have 19 sea provinces', () => {
    const sea = provinceIds.filter((id) => PROVINCES[id].type === ProvinceType.Sea);
    expect(sea.length).toBe(19);
  });

  it('should have 42 coastal provinces', () => {
    const coastal = provinceIds.filter((id) => PROVINCES[id].type === ProvinceType.Coastal);
    expect(coastal.length).toBe(42);
  });

  it('should have exactly 34 supply centers', () => {
    const scs = provinceIds.filter((id) => PROVINCES[id].supplyCenter);
    expect(scs.length).toBe(34);
  });

  it('should have 22 home supply centers', () => {
    const homeSCs = provinceIds.filter((id) => PROVINCES[id].homeCenter !== undefined);
    expect(homeSCs.length).toBe(22);
  });

  it('should have 12 neutral supply centers (supplyCenter true, no homeCenter)', () => {
    const neutralSCs = provinceIds.filter(
      (id) => PROVINCES[id].supplyCenter && PROVINCES[id].homeCenter === undefined,
    );
    expect(neutralSCs.length).toBe(12);
  });

  it('should have 22 starting units', () => {
    expect(STARTING_UNITS.length).toBe(22);
  });

  it('should have 22 entries in STARTING_SUPPLY_CENTERS', () => {
    expect(STARTING_SUPPLY_CENTERS.size).toBe(22);
  });
});

// ============================================================================
// Province Type Validation
// ============================================================================

describe('Province Type Validation', () => {
  const expectedInland = [
    'boh',
    'gal',
    'sil',
    'tyr',
    'bur',
    'ruh',
    'ukr',
    'mos',
    'bud',
    'vie',
    'war',
    'mun',
    'par',
    'ser',
  ];

  const expectedSea = [
    'nat',
    'nwg',
    'bar',
    'nth',
    'iri',
    'eng',
    'mao',
    'wes',
    'lyo',
    'tys',
    'ion',
    'adr',
    'aeg',
    'eas',
    'bla',
    'bal',
    'bot',
    'hel',
    'ska',
  ];

  it('should have all inland provinces typed as Land', () => {
    for (const id of expectedInland) {
      expect(PROVINCES[id].type, `${id} should be Land`).toBe(ProvinceType.Land);
    }
  });

  it('should have all sea provinces typed as Sea', () => {
    for (const id of expectedSea) {
      expect(PROVINCES[id].type, `${id} should be Sea`).toBe(ProvinceType.Sea);
    }
  });

  it('should give inland provinces no fleet adjacency', () => {
    for (const id of expectedInland) {
      const p = PROVINCES[id];
      expect(p.adjacency.fleet, `${id} fleet adj should be empty`).toEqual([]);
      expect(p.adjacency.fleetByCoast, `${id} should have no fleetByCoast`).toBeUndefined();
    }
  });

  it('should give sea provinces no army adjacency', () => {
    for (const id of expectedSea) {
      expect(PROVINCES[id].adjacency.army, `${id} army adj should be empty`).toEqual([]);
    }
  });

  describe('Multi-coast provinces', () => {
    const multiCoast = ['spa', 'stp', 'bul'];

    for (const id of multiCoast) {
      it(`${id} should have coasts array with North and South`, () => {
        const p = PROVINCES[id];
        expect(p.coasts).toBeDefined();
        expect(p.coasts).toContain(Coast.North);
        expect(p.coasts).toContain(Coast.South);
        expect(p.coasts!.length).toBe(2);
      });

      it(`${id} should have fleetByCoast entries for both coasts`, () => {
        const p = PROVINCES[id];
        expect(p.adjacency.fleetByCoast).toBeDefined();
        expect(p.adjacency.fleetByCoast![Coast.North]).toBeDefined();
        expect(p.adjacency.fleetByCoast![Coast.South]).toBeDefined();
        expect(p.adjacency.fleetByCoast![Coast.North]!.length).toBeGreaterThan(0);
        expect(p.adjacency.fleetByCoast![Coast.South]!.length).toBeGreaterThan(0);
      });

      it(`${id} should have empty main fleet array`, () => {
        expect(PROVINCES[id].adjacency.fleet).toEqual([]);
      });
    }
  });
});

// ============================================================================
// Adjacency Symmetry
// ============================================================================

describe('Adjacency Symmetry', () => {
  const allIds = Object.keys(PROVINCES);

  it('army adjacency should be symmetric', () => {
    for (const id of allIds) {
      for (const neighbor of PROVINCES[id].adjacency.army) {
        expect(
          PROVINCES[neighbor].adjacency.army,
          `${id} lists ${neighbor} in army adj, but ${neighbor} does not list ${id}`,
        ).toContain(id);
      }
    }
  });

  it('fleet adjacency should be symmetric (main fleet lists)', () => {
    for (const id of allIds) {
      for (const neighbor of PROVINCES[id].adjacency.fleet) {
        const np = PROVINCES[neighbor];
        const inMainFleet = np.adjacency.fleet.includes(id);
        let inCoastFleet = false;
        if (np.adjacency.fleetByCoast) {
          for (const coast of Object.values(Coast)) {
            if (np.adjacency.fleetByCoast[coast]?.includes(id)) {
              inCoastFleet = true;
              break;
            }
          }
        }
        expect(
          inMainFleet || inCoastFleet,
          `${id} lists ${neighbor} in fleet adj, but ${neighbor} does not list ${id} in fleet or any coast`,
        ).toBe(true);
      }
    }
  });

  it('fleet adjacency should be symmetric (fleetByCoast entries)', () => {
    for (const id of allIds) {
      const fbc = PROVINCES[id].adjacency.fleetByCoast;
      if (!fbc) continue;
      for (const coast of Object.values(Coast)) {
        const neighbors = fbc[coast];
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          const np = PROVINCES[neighbor];
          const inMainFleet = np.adjacency.fleet.includes(id);
          let inCoastFleet = false;
          if (np.adjacency.fleetByCoast) {
            for (const c of Object.values(Coast)) {
              if (np.adjacency.fleetByCoast[c]?.includes(id)) {
                inCoastFleet = true;
                break;
              }
            }
          }
          expect(
            inMainFleet || inCoastFleet,
            `${id}(${coast}) lists ${neighbor} in fleetByCoast, but ${neighbor} does not list ${id}`,
          ).toBe(true);
        }
      }
    }
  });

  it('no province should list itself in any adjacency list', () => {
    for (const id of allIds) {
      const p = PROVINCES[id];
      expect(p.adjacency.army, `${id} self-adj in army`).not.toContain(id);
      expect(p.adjacency.fleet, `${id} self-adj in fleet`).not.toContain(id);
      if (p.adjacency.fleetByCoast) {
        for (const coast of Object.values(Coast)) {
          const list = p.adjacency.fleetByCoast[coast];
          if (list) {
            expect(list, `${id} self-adj in fleetByCoast(${coast})`).not.toContain(id);
          }
        }
      }
    }
  });
});

// ============================================================================
// Starting Position Validation
// ============================================================================

describe('Starting Position Validation', () => {
  const findUnit = (province: string) => STARTING_UNITS.find((u) => u.province === province);

  describe('England starting units', () => {
    it('F lon', () => {
      const u = findUnit('lon');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.England);
    });
    it('F edi', () => {
      const u = findUnit('edi');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.England);
    });
    it('A lvp', () => {
      const u = findUnit('lvp');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.England);
    });
  });

  describe('France starting units', () => {
    it('F bre', () => {
      const u = findUnit('bre');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.France);
    });
    it('A par', () => {
      const u = findUnit('par');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.France);
    });
    it('A mar', () => {
      const u = findUnit('mar');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.France);
    });
  });

  describe('Germany starting units', () => {
    it('F kie', () => {
      const u = findUnit('kie');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.Germany);
    });
    it('A ber', () => {
      const u = findUnit('ber');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Germany);
    });
    it('A mun', () => {
      const u = findUnit('mun');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Germany);
    });
  });

  describe('Italy starting units', () => {
    it('F nap', () => {
      const u = findUnit('nap');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.Italy);
    });
    it('A rom', () => {
      const u = findUnit('rom');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Italy);
    });
    it('A ven', () => {
      const u = findUnit('ven');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Italy);
    });
  });

  describe('Austria starting units', () => {
    it('F tri', () => {
      const u = findUnit('tri');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.Austria);
    });
    it('A vie', () => {
      const u = findUnit('vie');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Austria);
    });
    it('A bud', () => {
      const u = findUnit('bud');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Austria);
    });
  });

  describe('Russia starting units', () => {
    it('F stp(sc)', () => {
      const u = findUnit('stp');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.Russia);
      expect(u!.coast).toBe(Coast.South);
    });
    it('F sev', () => {
      const u = findUnit('sev');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.Russia);
    });
    it('A mos', () => {
      const u = findUnit('mos');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Russia);
    });
    it('A war', () => {
      const u = findUnit('war');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Russia);
    });
  });

  describe('Turkey starting units', () => {
    it('F ank', () => {
      const u = findUnit('ank');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Fleet);
      expect(u!.power).toBe(Power.Turkey);
    });
    it('A con', () => {
      const u = findUnit('con');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Turkey);
    });
    it('A smy', () => {
      const u = findUnit('smy');
      expect(u).toBeDefined();
      expect(u!.type).toBe(UnitType.Army);
      expect(u!.power).toBe(Power.Turkey);
    });
  });

  it('starting supply centers should match home centers', () => {
    const allIds = Object.keys(PROVINCES);
    for (const id of allIds) {
      const p = PROVINCES[id];
      if (p.homeCenter !== undefined) {
        expect(
          STARTING_SUPPLY_CENTERS.has(id),
          `${id} has homeCenter ${p.homeCenter} but is not in STARTING_SUPPLY_CENTERS`,
        ).toBe(true);
        expect(
          STARTING_SUPPLY_CENTERS.get(id),
          `${id} STARTING_SUPPLY_CENTERS power should match homeCenter`,
        ).toBe(p.homeCenter);
      }
    }
  });

  it('home center counts per power should be correct', () => {
    const allIds = Object.keys(PROVINCES);
    const counts: Partial<Record<Power, number>> = {};
    for (const id of allIds) {
      const hc = PROVINCES[id].homeCenter;
      if (hc) counts[hc] = (counts[hc] || 0) + 1;
    }
    expect(counts[Power.England]).toBe(3);
    expect(counts[Power.France]).toBe(3);
    expect(counts[Power.Germany]).toBe(3);
    expect(counts[Power.Italy]).toBe(3);
    expect(counts[Power.Austria]).toBe(3);
    expect(counts[Power.Turkey]).toBe(3);
    expect(counts[Power.Russia]).toBe(4);
  });
});

// ============================================================================
// Specific Adjacency Spot-Checks
// ============================================================================

describe('Specific Adjacency Spot-Checks', () => {
  describe('England spot checks', () => {
    it('London army adj should include wal and yor but NOT edi', () => {
      const adj = PROVINCES['lon'].adjacency.army;
      expect(adj).toContain('wal');
      expect(adj).toContain('yor');
      expect(adj).not.toContain('edi');
    });

    it('London fleet adj should include eng, nth, wal, yor', () => {
      const adj = PROVINCES['lon'].adjacency.fleet;
      expect(adj).toContain('eng');
      expect(adj).toContain('nth');
      expect(adj).toContain('wal');
      expect(adj).toContain('yor');
    });

    it('Edinburgh fleet adj should include nth, nwg, cly, yor but NOT iri', () => {
      const adj = PROVINCES['edi'].adjacency.fleet;
      expect(adj).toContain('nth');
      expect(adj).toContain('nwg');
      expect(adj).toContain('cly');
      expect(adj).toContain('yor');
      expect(adj).not.toContain('iri');
    });
  });

  describe('Multi-coast spot checks', () => {
    it('Spain NC fleet adj: por, gas, mao', () => {
      const adj = PROVINCES['spa'].adjacency.fleetByCoast![Coast.North]!;
      expect(adj).toContain('por');
      expect(adj).toContain('gas');
      expect(adj).toContain('mao');
      expect(adj.length).toBe(3);
    });

    it('Spain SC fleet adj: por, mar, mao, lyo, wes', () => {
      const adj = PROVINCES['spa'].adjacency.fleetByCoast![Coast.South]!;
      expect(adj).toContain('por');
      expect(adj).toContain('mar');
      expect(adj).toContain('mao');
      expect(adj).toContain('lyo');
      expect(adj).toContain('wes');
      expect(adj.length).toBe(5);
    });

    it('St. Petersburg NC fleet adj: bar, nor, nwg (NOT fin, bot)', () => {
      const adj = PROVINCES['stp'].adjacency.fleetByCoast![Coast.North]!;
      expect(adj).toContain('bar');
      expect(adj).toContain('nor');
      expect(adj).toContain('nwg');
      expect(adj).not.toContain('fin');
      expect(adj).not.toContain('bot');
    });

    it('St. Petersburg SC fleet adj: fin, lvn, bot (NOT bar, nor)', () => {
      const adj = PROVINCES['stp'].adjacency.fleetByCoast![Coast.South]!;
      expect(adj).toContain('fin');
      expect(adj).toContain('lvn');
      expect(adj).toContain('bot');
      expect(adj).not.toContain('bar');
      expect(adj).not.toContain('nor');
    });

    it('Bulgaria EC (Coast.North) fleet adj: rum, con, bla', () => {
      const adj = PROVINCES['bul'].adjacency.fleetByCoast![Coast.North]!;
      expect(adj).toContain('rum');
      expect(adj).toContain('con');
      expect(adj).toContain('bla');
      expect(adj.length).toBe(3);
    });

    it('Bulgaria SC (Coast.South) fleet adj: con, gre, aeg', () => {
      const adj = PROVINCES['bul'].adjacency.fleetByCoast![Coast.South]!;
      expect(adj).toContain('con');
      expect(adj).toContain('gre');
      expect(adj).toContain('aeg');
      expect(adj.length).toBe(3);
    });
  });

  describe('Key inland verification — no fleet access', () => {
    const inlandProvinces = [
      'boh',
      'gal',
      'sil',
      'tyr',
      'bur',
      'ruh',
      'ukr',
      'mos',
      'bud',
      'vie',
      'war',
      'mun',
      'par',
      'ser',
    ];

    for (const id of inlandProvinces) {
      it(`${id} (${PROVINCES[id]?.name}) should have no fleet adjacency`, () => {
        const p = PROVINCES[id];
        expect(p.type).toBe(ProvinceType.Land);
        expect(p.adjacency.fleet).toEqual([]);
        expect(p.adjacency.fleetByCoast).toBeUndefined();
      });
    }
  });

  describe('Cross-body-of-water connections', () => {
    it('Denmark army adj includes kie, swe, nor', () => {
      const adj = PROVINCES['den'].adjacency.army;
      expect(adj).toContain('kie');
      expect(adj).toContain('swe');
      expect(adj).toContain('nor');
    });

    it('Constantinople army adj includes ank, smy, bul', () => {
      const adj = PROVINCES['con'].adjacency.army;
      expect(adj).toContain('ank');
      expect(adj).toContain('smy');
      expect(adj).toContain('bul');
    });

    it('Kiel army adj includes den', () => {
      expect(PROVINCES['kie'].adjacency.army).toContain('den');
    });
  });

  describe('No army connection between non-adjacent landmasses', () => {
    it('London army adj should NOT include any province across water', () => {
      const adj = PROVINCES['lon'].adjacency.army;
      expect(adj).not.toContain('bre');
      expect(adj).not.toContain('bel');
      expect(adj).not.toContain('pic');
      expect(adj).not.toContain('hol');
      expect(adj).not.toContain('den');
      expect(adj).not.toContain('nor');
    });

    it('Tunis army adj should only be naf', () => {
      const adj = PROVINCES['tun'].adjacency.army;
      expect(adj).toEqual(['naf']);
    });
  });
});
