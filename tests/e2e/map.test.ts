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
  'nat',
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
  'nat',
]);
