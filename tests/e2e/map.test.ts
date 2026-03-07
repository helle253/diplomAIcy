import { expect, test } from '@playwright/test';

import {
  makeSnapshot,
  STARTING_SC,
  STARTING_UNITS,
  startTestServer,
  type TestServer,
  type TestUnit,
} from './test-server.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer([makeSnapshot(STARTING_UNITS)]);
});

test.afterAll(async () => {
  await server.close();
});

/** Wait for the map SVG and units layer to render. */
async function waitForMap(page: import('@playwright/test').Page) {
  await page.goto(server.url);
  await page.waitForSelector('#units-layer', { state: 'attached', timeout: 10_000 });
  await page.waitForTimeout(500);
}

/**
 * Get the SVG-space position of each unit marker by reading the DOM.
 * Returns an array of { province, coast, cx, cy } from the rendered unit elements.
 */
async function getUnitPositions(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const layer = document.querySelector('#units-layer');
    if (!layer) return [];
    const markers = layer.querySelectorAll('.unit-marker');
    const results: { cx: number; cy: number }[] = [];
    for (const g of markers) {
      const circle = g.querySelector('circle');
      const rect = g.querySelector('rect');
      if (circle) {
        results.push({
          cx: parseFloat(circle.getAttribute('cx')!),
          cy: parseFloat(circle.getAttribute('cy')!),
        });
      } else if (rect) {
        results.push({
          cx: parseFloat(rect.getAttribute('x')!) + 7,
          cy: parseFloat(rect.getAttribute('y')!) + 7,
        });
      }
    }
    return results;
  });
}

/**
 * Get the bounding box of a province's path(s) in SVG coords.
 */
async function getProvinceBBox(page: import('@playwright/test').Page, province: string) {
  return page.evaluate((prov) => {
    const g = document.querySelector(`.province-group[data-province="${prov}"]`);
    if (!g) return null;
    const paths = g.querySelectorAll(':scope > path');
    if (paths.length === 0) return null;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const path of paths) {
      const bbox = (path as SVGGraphicsElement).getBBox();
      minX = Math.min(minX, bbox.x);
      minY = Math.min(minY, bbox.y);
      maxX = Math.max(maxX, bbox.x + bbox.width);
      maxY = Math.max(maxY, bbox.y + bbox.height);
    }
    return { minX, minY, maxX, maxY };
  }, province);
}

/**
 * Assert a unit's SVG position is inside (or very near) a province's bounding box.
 * Allows a margin for tokens near edges.
 */
function assertUnitInProvince(
  unit: { cx: number; cy: number },
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  label: string,
  margin = 15,
) {
  expect(unit.cx, `${label} cx within province`).toBeGreaterThanOrEqual(bbox.minX - margin);
  expect(unit.cx, `${label} cx within province`).toBeLessThanOrEqual(bbox.maxX + margin);
  expect(unit.cy, `${label} cy within province`).toBeGreaterThanOrEqual(bbox.minY - margin);
  expect(unit.cy, `${label} cy within province`).toBeLessThanOrEqual(bbox.maxY + margin);
}

// ===========================================================================
// Screenshot tests (visual baselines)
// ===========================================================================

test('starting positions — full map', async ({ page }) => {
  await waitForMap(page);
  const map = page.locator('#map-container');
  await expect(map).toHaveScreenshot('starting-positions-full.png');
});

test('empty map — no units', async ({ page }) => {
  server.setSnapshot(makeSnapshot([], {}));
  await waitForMap(page);
  const map = page.locator('#map-container');
  await expect(map).toHaveScreenshot('empty-map.png');
});

test('all provinces — unit on every province', async ({ page }) => {
  const units: TestUnit[] = ALL_PROVINCES.map((prov, i) => ({
    type: SEA_PROVINCES.has(prov) ? ('Fleet' as const) : ('Army' as const),
    power: POWERS_CYCLE[i % POWERS_CYCLE.length],
    province: prov,
  }));
  server.setSnapshot(makeSnapshot(units, STARTING_SC));
  await waitForMap(page);
  const map = page.locator('#map-container');
  await expect(map).toHaveScreenshot('all-provinces-units.png');
});

// ===========================================================================
// DOM position tests — verify each unit is within its province bounds
// ===========================================================================

test('starting units — each token inside its province bounds', async ({ page }) => {
  server.setSnapshot(makeSnapshot(STARTING_UNITS));
  await waitForMap(page);

  const positions = await getUnitPositions(page);
  expect(positions).toHaveLength(STARTING_UNITS.length);

  for (let i = 0; i < STARTING_UNITS.length; i++) {
    const unit = STARTING_UNITS[i];
    const bbox = await getProvinceBBox(page, unit.province);
    expect(bbox, `bbox for ${unit.province}`).not.toBeNull();
    assertUnitInProvince(
      positions[i],
      bbox!,
      `${unit.power} ${unit.type} ${unit.province}${unit.coast ? '/' + unit.coast : ''}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Split-coast position tests — verify fleet coasts are in correct region
// ---------------------------------------------------------------------------

test.describe('split coasts — St. Petersburg', () => {
  test('stp/nc fleet is north of stp/sc fleet', async ({ page }) => {
    const units: TestUnit[] = [
      { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'nc' },
      { type: 'Fleet', power: 'England', province: 'stp', coast: 'sc' },
    ];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    expect(positions).toHaveLength(2);

    const [nc, sc] = positions;
    // nc should be above (lower y) sc — toward Barents
    expect(nc.cy, 'stp/nc should be north of stp/sc').toBeLessThan(sc.cy);
    // They should be well separated (at least 30 SVG units apart)
    expect(sc.cy - nc.cy, 'stp coasts should be well separated').toBeGreaterThan(30);

    const bbox = await getProvinceBBox(page, 'stp');
    assertUnitInProvince(nc, bbox!, 'stp/nc');
    assertUnitInProvince(sc, bbox!, 'stp/sc');

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('stp-both-coasts.png');
  });

  test('stp/nc is near Barents Sea', async ({ page }) => {
    const units: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'stp', coast: 'nc' }];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const stpBBox = await getProvinceBBox(page, 'stp');

    // nc fleet should be in the upper third of STP, near BAR
    const stpTopThird = stpBBox!.minY + (stpBBox!.maxY - stpBBox!.minY) / 3;
    expect(positions[0].cy, 'stp/nc in upper third of STP').toBeLessThan(stpTopThird);

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('stp-nc-fleet.png');
  });

  test('stp/sc is near Gulf of Bothnia', async ({ page }) => {
    const units: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' }];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const stpBBox = await getProvinceBBox(page, 'stp');

    // sc fleet should be in the lower third of STP, near BOT
    const stpBottomThird = stpBBox!.minY + (2 * (stpBBox!.maxY - stpBBox!.minY)) / 3;
    expect(positions[0].cy, 'stp/sc in lower third of STP').toBeGreaterThan(stpBottomThird);

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('stp-sc-fleet.png');
  });
});

test.describe('split coasts — Spain', () => {
  test('spa/nc fleet is north of spa/sc fleet', async ({ page }) => {
    const units: TestUnit[] = [
      { type: 'Fleet', power: 'France', province: 'spa', coast: 'nc' },
      { type: 'Fleet', power: 'Italy', province: 'spa', coast: 'sc' },
    ];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const [nc, sc] = positions;

    expect(nc.cy, 'spa/nc north of spa/sc').toBeLessThan(sc.cy);
    expect(sc.cy - nc.cy, 'spa coasts should be well separated').toBeGreaterThan(20);

    const bbox = await getProvinceBBox(page, 'spa');
    assertUnitInProvince(nc, bbox!, 'spa/nc');
    assertUnitInProvince(sc, bbox!, 'spa/sc');

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('spa-both-coasts.png');
  });

  test('spa/nc is in upper half of Spain', async ({ page }) => {
    const units: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'spa', coast: 'nc' }];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const bbox = await getProvinceBBox(page, 'spa');
    const midY = (bbox!.minY + bbox!.maxY) / 2;
    expect(positions[0].cy, 'spa/nc in upper half').toBeLessThan(midY);

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('spa-nc-fleet.png');
  });

  test('spa/sc is in lower half of Spain', async ({ page }) => {
    const units: TestUnit[] = [{ type: 'Fleet', power: 'Italy', province: 'spa', coast: 'sc' }];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const bbox = await getProvinceBBox(page, 'spa');
    const midY = (bbox!.minY + bbox!.maxY) / 2;
    expect(positions[0].cy, 'spa/sc in lower half').toBeGreaterThan(midY);

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('spa-sc-fleet.png');
  });
});

test.describe('split coasts — Bulgaria', () => {
  test('bul/nc fleet is northeast of bul/sc fleet', async ({ page }) => {
    const units: TestUnit[] = [
      { type: 'Fleet', power: 'Turkey', province: 'bul', coast: 'nc' },
      { type: 'Fleet', power: 'Russia', province: 'bul', coast: 'sc' },
    ];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const [nc, sc] = positions;

    // nc (east/Black Sea coast) should be to the right (higher x)
    expect(nc.cx, 'bul/nc east of bul/sc').toBeGreaterThan(sc.cx);
    // nc should be above (lower y) or roughly same as sc
    expect(nc.cy, 'bul/nc north of bul/sc').toBeLessThan(sc.cy);

    const bbox = await getProvinceBBox(page, 'bul');
    assertUnitInProvince(nc, bbox!, 'bul/nc');
    assertUnitInProvince(sc, bbox!, 'bul/sc');

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('bul-both-coasts.png');
  });

  test('bul/nc is in eastern half of Bulgaria', async ({ page }) => {
    const units: TestUnit[] = [{ type: 'Fleet', power: 'Turkey', province: 'bul', coast: 'nc' }];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const bbox = await getProvinceBBox(page, 'bul');
    const midX = (bbox!.minX + bbox!.maxX) / 2;
    expect(positions[0].cx, 'bul/nc in eastern half').toBeGreaterThan(midX);

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('bul-nc-fleet.png');
  });

  test('bul/sc is in southern half of Bulgaria', async ({ page }) => {
    const units: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'bul', coast: 'sc' }];
    server.setSnapshot(makeSnapshot(units));
    await waitForMap(page);

    const positions = await getUnitPositions(page);
    const bbox = await getProvinceBBox(page, 'bul');
    const midY = (bbox!.minY + bbox!.maxY) / 2;
    expect(positions[0].cy, 'bul/sc in southern half').toBeGreaterThan(midY);

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('bul-sc-fleet.png');
  });
});

// ---------------------------------------------------------------------------
// Army on split-coast province (no coast — should use UNIT_OFFSETS)
// ---------------------------------------------------------------------------

test('army on split-coast provinces — centered, no coast offset', async ({ page }) => {
  const units: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'spa' },
    { type: 'Army', power: 'Turkey', province: 'bul' },
    { type: 'Army', power: 'Russia', province: 'stp' },
  ];
  server.setSnapshot(makeSnapshot(units));
  await waitForMap(page);

  const positions = await getUnitPositions(page);
  expect(positions).toHaveLength(3);

  for (let i = 0; i < units.length; i++) {
    const bbox = await getProvinceBBox(page, units[i].province);
    assertUnitInProvince(positions[i], bbox!, `Army in ${units[i].province}`);
  }

  const map = page.locator('#map-container');
  await expect(map).toHaveScreenshot('armies-on-split-coast-provinces.png');
});

// ===========================================================================
// Region shading tests — verify supply center ownership shades land provinces
// ===========================================================================

// All land/coastal provinces (excludes sea zones which can't be owned)
const LAND_PROVINCES = [
  'cly',
  'edi',
  'lvp',
  'yor',
  'wal',
  'lon',
  'bre',
  'pic',
  'par',
  'gas',
  'bur',
  'mar',
  'por',
  'spa',
  'bel',
  'hol',
  'ruh',
  'kie',
  'ber',
  'mun',
  'nor',
  'swe',
  'den',
  'fin',
  'stp',
  'mos',
  'war',
  'lvn',
  'ukr',
  'sev',
  'pie',
  'ven',
  'tus',
  'rom',
  'nap',
  'apu',
  'tyr',
  'boh',
  'vie',
  'tri',
  'bud',
  'gal',
  'ser',
  'alb',
  'gre',
  'bul',
  'rum',
  'con',
  'ank',
  'smy',
  'arm',
  'syr',
  'naf',
  'tun',
  'sil',
  'pru',
];

test.describe('region shading', () => {
  test('every land province shades for each power', async ({ page }) => {
    // Assign every land province to a power (cycling through them)
    const powers = ['England', 'France', 'Germany', 'Italy', 'Austria', 'Russia', 'Turkey'];
    const sc: Record<string, string> = {};
    for (let i = 0; i < LAND_PROVINCES.length; i++) {
      sc[LAND_PROVINCES[i]] = powers[i % powers.length];
    }

    server.setSnapshot(makeSnapshot([], sc));
    await waitForMap(page);

    for (const province of LAND_PROVINCES) {
      const expectedPower = sc[province];
      const group = page.locator(`.province-group[data-province="${province}"]`);
      await expect(group, `${province} shaded as ${expectedPower}`).toHaveClass(
        new RegExp(`power-${expectedPower}`),
      );
    }

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('region-shading-all-powers.png');
  });

  test('empty ownership — no provinces shaded', async ({ page }) => {
    server.setSnapshot(makeSnapshot([], {}));
    await waitForMap(page);

    // Every land province should have NO power class
    for (const province of LAND_PROVINCES) {
      const group = page.locator(`.province-group[data-province="${province}"]`);
      const classes = await group.getAttribute('class');
      expect(classes, `${province} has no power class`).not.toMatch(/power-/);
    }
  });

  test('ownership changes update shading', async ({ page }) => {
    // Start with starting SC ownership
    server.setSnapshot(makeSnapshot(STARTING_UNITS));
    await waitForMap(page);

    // Verify a starting position
    await expect(page.locator('.province-group[data-province="lon"]')).toHaveClass(/power-England/);
    await expect(page.locator('.province-group[data-province="bel"]')).not.toHaveClass(/power-/);

    // Now simulate mid-game: conquests
    const sc = {
      ...STARTING_SC,
      bel: 'France',
      hol: 'Germany',
      den: 'Germany',
      nor: 'England',
      tun: 'Italy',
      bul: 'Turkey',
      rum: 'Russia',
      ser: 'Austria',
    };
    server.setSnapshot(makeSnapshot([], sc));
    await waitForMap(page);

    await expect(page.locator('.province-group[data-province="bel"]')).toHaveClass(/power-France/);
    await expect(page.locator('.province-group[data-province="hol"]')).toHaveClass(/power-Germany/);
    await expect(page.locator('.province-group[data-province="tun"]')).toHaveClass(/power-Italy/);
    await expect(page.locator('.province-group[data-province="bul"]')).toHaveClass(/power-Turkey/);
    await expect(page.locator('.province-group[data-province="rum"]')).toHaveClass(/power-Russia/);
    await expect(page.locator('.province-group[data-province="ser"]')).toHaveClass(/power-Austria/);

    const map = page.locator('#map-container');
    await expect(map).toHaveScreenshot('region-shading-mid-game.png');
  });
});

// ===========================================================================
// Constants
// ===========================================================================

const ALL_PROVINCES = [
  'cly',
  'edi',
  'lvp',
  'yor',
  'wal',
  'lon',
  'bre',
  'pic',
  'par',
  'gas',
  'bur',
  'mar',
  'por',
  'spa',
  'bel',
  'hol',
  'ruh',
  'kie',
  'ber',
  'mun',
  'nor',
  'swe',
  'den',
  'fin',
  'stp',
  'mos',
  'war',
  'lvn',
  'ukr',
  'sev',
  'pie',
  'ven',
  'tus',
  'rom',
  'nap',
  'apu',
  'tyr',
  'boh',
  'vie',
  'tri',
  'bud',
  'gal',
  'ser',
  'alb',
  'gre',
  'bul',
  'rum',
  'con',
  'ank',
  'smy',
  'arm',
  'syr',
  'naf',
  'tun',
  'nth',
  'nwg',
  'bar',
  'ska',
  'hel',
  'bal',
  'bot',
  'iri',
  'eng',
  'mao',
  'wes',
  'lyo',
  'tyn',
  'ion',
  'adr',
  'aeg',
  'eas',
  'bla',
];

const POWERS_CYCLE = ['England', 'France', 'Germany', 'Italy', 'Austria', 'Russia', 'Turkey'];

const SEA_PROVINCES = new Set([
  'nth',
  'nwg',
  'bar',
  'ska',
  'hel',
  'bal',
  'bot',
  'iri',
  'eng',
  'mao',
  'wes',
  'lyo',
  'tyn',
  'ion',
  'adr',
  'aeg',
  'eas',
  'bla',
]);
