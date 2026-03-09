// Per-province fleet position overrides. Falls back to UNIT_OFFSETS if not specified.
// Used to place fleets near coastlines while armies stay inland.
export const FLEET_OFFSETS: Record<string, { dx: number; dy: number }> = {
  // Coastal provinces where fleet should differ from army
  ank: { dx: 1, dy: -20 }, // near BLA coast
  apu: { dx: 3, dy: -16 }, // near ADR coast
  arm: { dx: -22, dy: -33 }, // near BLA coast (northwest edge)
  bel: { dx: -14, dy: -18 }, // near ENG coast
  bre: { dx: -5, dy: -20 },
  con: { dx: -8, dy: -10 }, // near AEG/BLA coast
  den: { dx: 4, dy: 8 }, // near SKA/HEL coast
  fin: { dx: -10, dy: -35 }, // near BOT coast
  gas: { dx: -8, dy: -20 },
  gre: { dx: 15, dy: 10 }, // near ION/AEG coast
  hol: { dx: -10, dy: 4 }, // near NTH coast
  kie: { dx: 10, dy: -20 }, // near HEL/BAL coast
  lvn: { dx: -15, dy: -25 }, // near BAL coast
  mar: { dx: -8, dy: 8 },
  naf: { dx: -15, dy: -20 }, // near WES/MAO coast
  nor: { dx: 15, dy: -30 }, // near NWG coast
  pru: { dx: -10, dy: -20 }, // near BAL coast
  rom: { dx: 0, dy: 6 },
  rum: { dx: 5, dy: -5 }, // near BLA coast
  sev: { dx: -24, dy: 10 }, // near BLA coast
  smy: { dx: -20, dy: 12 },
  swe: { dx: 10, dy: -40 }, // near BOT/SKA coast
  tri: { dx: 10, dy: -10 }, // near ADR coast
  ven: { dx: 10, dy: 10 }, // near ADR coast
  // Sea zones (fleet-only provinces)
  adr: { dx: -16, dy: -22 },
  aeg: { dx: 10, dy: 12 },
  bal: { dx: 12, dy: -20 },
  bar: { dx: 11, dy: 15 },
  ber: { dx: 7, dy: -20 },
  bla: { dx: -25, dy: -3 },
  bot: { dx: 15, dy: 20 },
  eas: { dx: -16, dy: -3 },
  eng: { dx: -16, dy: 1 },
  hel: { dx: 8, dy: -15 },
  ion: { dx: -10, dy: 10 },
  iri: { dx: 4, dy: 11 },
  lyo: { dx: 4, dy: -21 },
  mao: { dx: 14, dy: 42 },
  nat: { dx: 9, dy: 17 },
  nth: { dx: 4, dy: 11 },
  nwg: { dx: 35, dy: 29 },
  ska: { dx: 12, dy: -8 },
  tun: { dx: 4, dy: -36 },
  tus: { dx: 0, dy: 4 },
  tys: { dx: 11, dy: -22 },
  wal: { dx: -2, dy: 6 },
  wes: { dx: -32, dy: 3 },
};

// Pixel offsets for fleet placement on multi-coast provinces.
// Keys are "province/coast", values are {dx, dy} relative to the province text label.
// Positions are chosen near the relevant coastline rather than at the province center.
export const COAST_OFFSETS: Record<string, { dx: number; dy: number }> = {
  'stp/nc': { dx: 0, dy: -42 }, // toward Barents Sea (bottom of bay)
  'stp/sc': { dx: -65, dy: 46 }, // toward Gulf of Bothnia (south coast)
  'spa/nc': { dx: 15, dy: -52 }, // toward Bay of Biscay / Gascony (north coast)
  'spa/sc': { dx: 32, dy: 0 }, // toward Western Med (south coast)
  'bul/nc': { dx: 30, dy: -3 }, // northeast corner toward Black Sea
  'bul/sc': { dx: 4, dy: 28 }, // southern edge toward Aegean
};
