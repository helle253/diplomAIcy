import { Coast, Power, Province, ProvinceType, Unit, UnitType } from './types';

// ============================================================================
// Standard Diplomacy Map Data
// ============================================================================
//
// Multi-coast provinces:
//   - Spain (spa): nc = north coast, sc = south coast
//   - St. Petersburg (stp): nc = north coast, sc = south coast
//   - Bulgaria (bul): nc = east coast, sc = south coast
//     (Bulgaria's east coast is mapped to Coast.North and south coast to
//      Coast.South because the Coast enum only has two values.)
//
// Province types:
//   - Land: inland, only armies can enter (no fleet access)
//   - Sea: only fleets can enter
//   - Coastal: both armies and fleets can enter
//
// Inland provinces (Land): boh, gal, sil, tyr, bur, ruh, ukr, mos, bud, vie,
//                          war, mun, par, ser
// ============================================================================

const L = ProvinceType.Land;
const S = ProvinceType.Sea;
const C = ProvinceType.Coastal;

export const PROVINCES: Record<string, Province> = {
  // ===========================================================================
  // ENGLAND
  // ===========================================================================
  lon: {
    id: 'lon',
    name: 'London',
    type: C,
    supplyCenter: true,
    homeCenter: Power.England,
    adjacency: {
      army: ['wal', 'yor'],
      fleet: ['wal', 'yor', 'eng', 'nth'],
    },
  },
  edi: {
    id: 'edi',
    name: 'Edinburgh',
    type: C,
    supplyCenter: true,
    homeCenter: Power.England,
    adjacency: {
      army: ['cly', 'yor', 'lvp'],
      fleet: ['cly', 'yor', 'nth', 'nwg'],
    },
  },
  lvp: {
    id: 'lvp',
    name: 'Liverpool',
    type: C,
    supplyCenter: true,
    homeCenter: Power.England,
    adjacency: {
      army: ['cly', 'edi', 'yor', 'wal'],
      fleet: ['cly', 'wal', 'iri', 'nat'],
    },
  },
  cly: {
    id: 'cly',
    name: 'Clyde',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['edi', 'lvp'],
      fleet: ['edi', 'lvp', 'nat', 'nwg'],
    },
  },
  wal: {
    id: 'wal',
    name: 'Wales',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['lon', 'lvp', 'yor'],
      fleet: ['lon', 'lvp', 'iri', 'eng'],
    },
  },
  yor: {
    id: 'yor',
    name: 'Yorkshire',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['lon', 'edi', 'lvp', 'wal'],
      fleet: ['lon', 'edi', 'nth'],
    },
  },

  // ===========================================================================
  // FRANCE
  // ===========================================================================
  par: {
    id: 'par',
    name: 'Paris',
    type: L,
    supplyCenter: true,
    homeCenter: Power.France,
    adjacency: {
      army: ['bre', 'pic', 'bur', 'gas'],
      fleet: [],
    },
  },
  bre: {
    id: 'bre',
    name: 'Brest',
    type: C,
    supplyCenter: true,
    homeCenter: Power.France,
    adjacency: {
      army: ['par', 'pic', 'gas'],
      fleet: ['pic', 'gas', 'eng', 'mao'],
    },
  },
  mar: {
    id: 'mar',
    name: 'Marseilles',
    type: C,
    supplyCenter: true,
    homeCenter: Power.France,
    adjacency: {
      army: ['bur', 'gas', 'pie', 'spa'],
      fleet: ['pie', 'spa', 'lyo'],
    },
  },
  pic: {
    id: 'pic',
    name: 'Picardy',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['par', 'bre', 'bur', 'bel'],
      fleet: ['bre', 'bel', 'eng'],
    },
  },
  bur: {
    id: 'bur',
    name: 'Burgundy',
    type: L,
    supplyCenter: false,
    adjacency: {
      army: ['par', 'pic', 'mar', 'gas', 'bel', 'ruh', 'mun'],
      fleet: [],
    },
  },
  gas: {
    id: 'gas',
    name: 'Gascony',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['par', 'bre', 'bur', 'mar', 'spa'],
      fleet: ['bre', 'spa', 'mao'],
    },
  },

  // ===========================================================================
  // GERMANY
  // ===========================================================================
  ber: {
    id: 'ber',
    name: 'Berlin',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Germany,
    adjacency: {
      army: ['kie', 'mun', 'pru', 'sil'],
      fleet: ['kie', 'pru', 'bal'],
    },
  },
  kie: {
    id: 'kie',
    name: 'Kiel',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Germany,
    adjacency: {
      army: ['ber', 'mun', 'ruh', 'hol', 'den'],
      fleet: ['ber', 'hol', 'den', 'bal', 'hel'],
    },
  },
  mun: {
    id: 'mun',
    name: 'Munich',
    type: L,
    supplyCenter: true,
    homeCenter: Power.Germany,
    adjacency: {
      army: ['ber', 'kie', 'ruh', 'bur', 'tyr', 'boh', 'sil'],
      fleet: [],
    },
  },
  pru: {
    id: 'pru',
    name: 'Prussia',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['ber', 'sil', 'war', 'lvn'],
      fleet: ['ber', 'lvn', 'bal'],
    },
  },
  ruh: {
    id: 'ruh',
    name: 'Ruhr',
    type: L,
    supplyCenter: false,
    adjacency: {
      army: ['kie', 'mun', 'bur', 'bel', 'hol'],
      fleet: [],
    },
  },
  sil: {
    id: 'sil',
    name: 'Silesia',
    type: L,
    supplyCenter: false,
    adjacency: {
      army: ['ber', 'mun', 'pru', 'war', 'gal', 'boh'],
      fleet: [],
    },
  },

  // ===========================================================================
  // ITALY
  // ===========================================================================
  rom: {
    id: 'rom',
    name: 'Rome',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Italy,
    adjacency: {
      army: ['nap', 'ven', 'tus', 'apu'],
      fleet: ['nap', 'tus', 'tys'],
    },
  },
  nap: {
    id: 'nap',
    name: 'Naples',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Italy,
    adjacency: {
      army: ['rom', 'apu'],
      fleet: ['rom', 'apu', 'tys', 'ion'],
    },
  },
  ven: {
    id: 'ven',
    name: 'Venice',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Italy,
    adjacency: {
      army: ['rom', 'tus', 'pie', 'tyr', 'tri', 'apu'],
      fleet: ['tri', 'apu', 'adr'],
    },
  },
  pie: {
    id: 'pie',
    name: 'Piedmont',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['mar', 'ven', 'tus', 'tyr'],
      fleet: ['mar', 'tus', 'lyo'],
    },
  },
  tus: {
    id: 'tus',
    name: 'Tuscany',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['rom', 'ven', 'pie'],
      fleet: ['rom', 'pie', 'lyo', 'tys'],
    },
  },
  apu: {
    id: 'apu',
    name: 'Apulia',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['rom', 'nap', 'ven'],
      fleet: ['nap', 'ven', 'adr', 'ion'],
    },
  },

  // ===========================================================================
  // AUSTRIA
  // ===========================================================================
  vie: {
    id: 'vie',
    name: 'Vienna',
    type: L,
    supplyCenter: true,
    homeCenter: Power.Austria,
    adjacency: {
      army: ['bud', 'tri', 'boh', 'gal', 'tyr'],
      fleet: [],
    },
  },
  bud: {
    id: 'bud',
    name: 'Budapest',
    type: L,
    supplyCenter: true,
    homeCenter: Power.Austria,
    adjacency: {
      army: ['vie', 'tri', 'gal', 'rum', 'ser'],
      fleet: [],
    },
  },
  tri: {
    id: 'tri',
    name: 'Trieste',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Austria,
    adjacency: {
      army: ['vie', 'bud', 'ven', 'tyr', 'ser', 'alb'],
      fleet: ['ven', 'alb', 'adr'],
    },
  },
  boh: {
    id: 'boh',
    name: 'Bohemia',
    type: L,
    supplyCenter: false,
    adjacency: {
      army: ['vie', 'mun', 'sil', 'gal', 'tyr'],
      fleet: [],
    },
  },
  gal: {
    id: 'gal',
    name: 'Galicia',
    type: L,
    supplyCenter: false,
    adjacency: {
      army: ['vie', 'bud', 'boh', 'sil', 'war', 'ukr', 'rum'],
      fleet: [],
    },
  },
  tyr: {
    id: 'tyr',
    name: 'Tyrolia',
    type: L,
    supplyCenter: false,
    adjacency: {
      army: ['vie', 'mun', 'boh', 'tri', 'ven', 'pie'],
      fleet: [],
    },
  },

  // ===========================================================================
  // RUSSIA
  // ===========================================================================
  mos: {
    id: 'mos',
    name: 'Moscow',
    type: L,
    supplyCenter: true,
    homeCenter: Power.Russia,
    adjacency: {
      army: ['stp', 'war', 'ukr', 'sev', 'lvn'],
      fleet: [],
    },
  },
  stp: {
    id: 'stp',
    name: 'St. Petersburg',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Russia,
    coasts: [Coast.North, Coast.South],
    adjacency: {
      army: ['mos', 'fin', 'lvn', 'nor'],
      fleet: [],
      fleetByCoast: {
        [Coast.North]: ['bar', 'nor', 'nwg'],
        [Coast.South]: ['fin', 'lvn', 'bot'],
      },
    },
  },
  war: {
    id: 'war',
    name: 'Warsaw',
    type: L,
    supplyCenter: true,
    homeCenter: Power.Russia,
    adjacency: {
      army: ['mos', 'sil', 'pru', 'lvn', 'gal', 'ukr'],
      fleet: [],
    },
  },
  sev: {
    id: 'sev',
    name: 'Sevastopol',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Russia,
    adjacency: {
      army: ['mos', 'ukr', 'rum', 'arm'],
      fleet: ['rum', 'arm', 'bla'],
    },
  },
  ukr: {
    id: 'ukr',
    name: 'Ukraine',
    type: L,
    supplyCenter: false,
    adjacency: {
      army: ['mos', 'war', 'sev', 'rum', 'gal'],
      fleet: [],
    },
  },
  lvn: {
    id: 'lvn',
    name: 'Livonia',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['mos', 'stp', 'war', 'pru'],
      fleet: ['stp', 'pru', 'bal', 'bot'],
    },
  },
  fin: {
    id: 'fin',
    name: 'Finland',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['stp', 'swe', 'nor'],
      fleet: ['stp', 'swe', 'bot'],
    },
  },

  // ===========================================================================
  // TURKEY
  // ===========================================================================
  con: {
    id: 'con',
    name: 'Constantinople',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Turkey,
    adjacency: {
      army: ['ank', 'smy', 'bul'],
      fleet: ['ank', 'smy', 'bul', 'bla', 'aeg'],
    },
  },
  ank: {
    id: 'ank',
    name: 'Ankara',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Turkey,
    adjacency: {
      army: ['con', 'smy', 'arm'],
      fleet: ['con', 'arm', 'bla'],
    },
  },
  smy: {
    id: 'smy',
    name: 'Smyrna',
    type: C,
    supplyCenter: true,
    homeCenter: Power.Turkey,
    adjacency: {
      army: ['con', 'ank', 'arm', 'syr'],
      fleet: ['con', 'syr', 'aeg', 'eas'],
    },
  },
  arm: {
    id: 'arm',
    name: 'Armenia',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['ank', 'smy', 'sev', 'syr'],
      fleet: ['ank', 'sev', 'bla'],
    },
  },
  syr: {
    id: 'syr',
    name: 'Syria',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['smy', 'arm'],
      fleet: ['smy', 'eas'],
    },
  },

  // ===========================================================================
  // NEUTRAL SUPPLY CENTERS
  // ===========================================================================
  nor: {
    id: 'nor',
    name: 'Norway',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['stp', 'fin', 'swe', 'den'],
      fleet: ['stp', 'swe', 'den', 'nth', 'nwg', 'ska', 'bar'],
    },
  },
  swe: {
    id: 'swe',
    name: 'Sweden',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['nor', 'fin', 'den'],
      fleet: ['nor', 'fin', 'den', 'bal', 'bot', 'ska'],
    },
  },
  den: {
    id: 'den',
    name: 'Denmark',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['kie', 'swe', 'nor'],
      fleet: ['kie', 'swe', 'nor', 'nth', 'bal', 'hel', 'ska'],
    },
  },
  hol: {
    id: 'hol',
    name: 'Holland',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['kie', 'ruh', 'bel'],
      fleet: ['kie', 'bel', 'nth', 'hel'],
    },
  },
  bel: {
    id: 'bel',
    name: 'Belgium',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['pic', 'bur', 'ruh', 'hol'],
      fleet: ['pic', 'hol', 'eng', 'nth'],
    },
  },
  spa: {
    id: 'spa',
    name: 'Spain',
    type: C,
    supplyCenter: true,
    coasts: [Coast.North, Coast.South],
    adjacency: {
      army: ['por', 'gas', 'mar'],
      fleet: [],
      fleetByCoast: {
        [Coast.North]: ['por', 'gas', 'mao'],
        [Coast.South]: ['por', 'mar', 'mao', 'lyo', 'wes'],
      },
    },
  },
  por: {
    id: 'por',
    name: 'Portugal',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['spa'],
      fleet: ['spa', 'mao'],
    },
  },
  tun: {
    id: 'tun',
    name: 'Tunis',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['naf'],
      fleet: ['naf', 'wes', 'tys', 'ion'],
    },
  },
  ser: {
    id: 'ser',
    name: 'Serbia',
    type: L,
    supplyCenter: true,
    adjacency: {
      army: ['bud', 'tri', 'rum', 'bul', 'gre', 'alb'],
      fleet: [],
    },
  },
  rum: {
    id: 'rum',
    name: 'Romania',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['bud', 'gal', 'ukr', 'sev', 'bul', 'ser'],
      fleet: ['sev', 'bul', 'bla'],
    },
  },
  bul: {
    id: 'bul',
    name: 'Bulgaria',
    type: C,
    supplyCenter: true,
    // nc = east coast, sc = south coast (see note at top of file)
    coasts: [Coast.North, Coast.South],
    adjacency: {
      army: ['con', 'rum', 'ser', 'gre'],
      fleet: [],
      fleetByCoast: {
        // East coast (mapped to Coast.North): borders Black Sea, Romania, Constantinople
        [Coast.North]: ['rum', 'con', 'bla'],
        // South coast (Coast.South): borders Constantinople, Aegean Sea, Greece
        [Coast.South]: ['con', 'gre', 'aeg'],
      },
    },
  },
  gre: {
    id: 'gre',
    name: 'Greece',
    type: C,
    supplyCenter: true,
    adjacency: {
      army: ['ser', 'bul', 'alb'],
      fleet: ['bul', 'alb', 'ion', 'aeg'],
    },
  },

  // ===========================================================================
  // NON-SUPPLY-CENTER NEUTRALS
  // ===========================================================================
  naf: {
    id: 'naf',
    name: 'North Africa',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['tun'],
      fleet: ['tun', 'mao', 'wes'],
    },
  },
  alb: {
    id: 'alb',
    name: 'Albania',
    type: C,
    supplyCenter: false,
    adjacency: {
      army: ['tri', 'ser', 'gre'],
      fleet: ['tri', 'gre', 'adr', 'ion'],
    },
  },

  // ===========================================================================
  // SEA PROVINCES
  // ===========================================================================
  nat: {
    id: 'nat',
    name: 'North Atlantic Ocean',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nwg', 'cly', 'lvp', 'iri', 'mao'],
    },
  },
  nwg: {
    id: 'nwg',
    name: 'Norwegian Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nat', 'bar', 'nor', 'nth', 'edi', 'cly', 'stp'],
    },
  },
  bar: {
    id: 'bar',
    name: 'Barents Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nwg', 'nor', 'stp'],
    },
  },
  nth: {
    id: 'nth',
    name: 'North Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nwg', 'nor', 'ska', 'den', 'hel', 'hol', 'bel', 'eng', 'lon', 'yor', 'edi'],
    },
  },
  iri: {
    id: 'iri',
    name: 'Irish Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nat', 'lvp', 'wal', 'eng', 'mao'],
    },
  },
  eng: {
    id: 'eng',
    name: 'English Channel',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['iri', 'mao', 'nth', 'lon', 'wal', 'bre', 'pic', 'bel'],
    },
  },
  mao: {
    id: 'mao',
    name: 'Mid-Atlantic Ocean',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nat', 'iri', 'eng', 'bre', 'gas', 'spa', 'por', 'naf', 'wes'],
    },
  },
  wes: {
    id: 'wes',
    name: 'Western Mediterranean',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['mao', 'spa', 'lyo', 'tys', 'tun', 'naf'],
    },
  },
  lyo: {
    id: 'lyo',
    name: 'Gulf of Lyon',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['mar', 'spa', 'pie', 'tus', 'tys', 'wes'],
    },
  },
  tys: {
    id: 'tys',
    name: 'Tyrrhenian Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['lyo', 'wes', 'tun', 'ion', 'nap', 'rom', 'tus'],
    },
  },
  ion: {
    id: 'ion',
    name: 'Ionian Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['tys', 'tun', 'adr', 'aeg', 'eas', 'nap', 'apu', 'alb', 'gre'],
    },
  },
  adr: {
    id: 'adr',
    name: 'Adriatic Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['ion', 'ven', 'tri', 'alb', 'apu'],
    },
  },
  aeg: {
    id: 'aeg',
    name: 'Aegean Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['ion', 'eas', 'gre', 'bul', 'con', 'smy'],
    },
  },
  eas: {
    id: 'eas',
    name: 'Eastern Mediterranean',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['ion', 'aeg', 'smy', 'syr'],
    },
  },
  bla: {
    id: 'bla',
    name: 'Black Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['rum', 'sev', 'arm', 'ank', 'con', 'bul'],
    },
  },
  bal: {
    id: 'bal',
    name: 'Baltic Sea',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['bot', 'swe', 'den', 'kie', 'ber', 'pru', 'lvn'],
    },
  },
  bot: {
    id: 'bot',
    name: 'Gulf of Bothnia',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['bal', 'swe', 'fin', 'stp', 'lvn'],
    },
  },
  hel: {
    id: 'hel',
    name: 'Heligoland Bight',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nth', 'den', 'kie', 'hol'],
    },
  },
  ska: {
    id: 'ska',
    name: 'Skagerrak',
    type: S,
    supplyCenter: false,
    adjacency: {
      army: [],
      fleet: ['nth', 'nor', 'swe', 'den'],
    },
  },
};

// ============================================================================
// STARTING UNITS (Spring 1901)
// ============================================================================

export const STARTING_UNITS: Unit[] = [
  // England
  { type: UnitType.Fleet, power: Power.England, province: 'lon' },
  { type: UnitType.Fleet, power: Power.England, province: 'edi' },
  { type: UnitType.Army, power: Power.England, province: 'lvp' },

  // France
  { type: UnitType.Fleet, power: Power.France, province: 'bre' },
  { type: UnitType.Army, power: Power.France, province: 'par' },
  { type: UnitType.Army, power: Power.France, province: 'mar' },

  // Germany
  { type: UnitType.Fleet, power: Power.Germany, province: 'kie' },
  { type: UnitType.Army, power: Power.Germany, province: 'ber' },
  { type: UnitType.Army, power: Power.Germany, province: 'mun' },

  // Italy
  { type: UnitType.Fleet, power: Power.Italy, province: 'nap' },
  { type: UnitType.Army, power: Power.Italy, province: 'rom' },
  { type: UnitType.Army, power: Power.Italy, province: 'ven' },

  // Austria
  { type: UnitType.Fleet, power: Power.Austria, province: 'tri' },
  { type: UnitType.Army, power: Power.Austria, province: 'vie' },
  { type: UnitType.Army, power: Power.Austria, province: 'bud' },

  // Russia
  { type: UnitType.Fleet, power: Power.Russia, province: 'stp', coast: Coast.South },
  { type: UnitType.Fleet, power: Power.Russia, province: 'sev' },
  { type: UnitType.Army, power: Power.Russia, province: 'mos' },
  { type: UnitType.Army, power: Power.Russia, province: 'war' },

  // Turkey
  { type: UnitType.Fleet, power: Power.Turkey, province: 'ank' },
  { type: UnitType.Army, power: Power.Turkey, province: 'con' },
  { type: UnitType.Army, power: Power.Turkey, province: 'smy' },
];

// ============================================================================
// STARTING SUPPLY CENTER OWNERSHIP
// ============================================================================

export const STARTING_SUPPLY_CENTERS: Map<string, Power> = new Map([
  // England
  ['lon', Power.England],
  ['edi', Power.England],
  ['lvp', Power.England],

  // France
  ['par', Power.France],
  ['bre', Power.France],
  ['mar', Power.France],

  // Germany
  ['ber', Power.Germany],
  ['kie', Power.Germany],
  ['mun', Power.Germany],

  // Italy
  ['rom', Power.Italy],
  ['nap', Power.Italy],
  ['ven', Power.Italy],

  // Austria
  ['vie', Power.Austria],
  ['bud', Power.Austria],
  ['tri', Power.Austria],

  // Russia
  ['mos', Power.Russia],
  ['stp', Power.Russia],
  ['war', Power.Russia],
  ['sev', Power.Russia],

  // Turkey
  ['con', Power.Turkey],
  ['ank', Power.Turkey],
  ['smy', Power.Turkey],
]);
