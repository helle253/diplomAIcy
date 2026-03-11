import { expect, test } from '@playwright/test';

import {
  makeHold,
  makeMove,
  makeOrdersSnapshot,
  makeSnapshot,
  STARTING_SC,
  startTestServer,
  type TestServer,
  type TestUnit,
} from './test-server.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer([makeSnapshot([])]);
});

test.afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupArrowScenario(
  page: import('@playwright/test').Page,
  beforeUnits: TestUnit[],
  afterUnits: TestUnit[],
  orders: Parameters<typeof makeOrdersSnapshot>[1],
) {
  const diplomacySnap = makeSnapshot(beforeUnits, STARTING_SC, {
    year: 1901,
    season: 'Spring',
    type: 'Diplomacy',
  });
  const ordersSnap = makeOrdersSnapshot(afterUnits, orders, STARTING_SC, {
    year: 1901,
    season: 'Spring',
    type: 'Orders',
  });
  server.setSnapshots([diplomacySnap, ordersSnap]);
  return page.evaluate(() => {
    const slider = document.querySelector('#phase-slider') as HTMLInputElement;
    slider.value = '1';
    slider.dispatchEvent(new Event('input'));
  });
}

interface ArrowInfo {
  tag: string;
  stroke: string;
  strokeDasharray: string | null;
  markerEnd: string | null;
  opacity: string | null;
}

async function getArrows(page: import('@playwright/test').Page): Promise<ArrowInfo[]> {
  return page.evaluate(() => {
    const layer = document.querySelector('#arrows-layer');
    if (!layer) return [];
    return Array.from(layer.children).map((el) => ({
      tag: el.tagName.toLowerCase(),
      stroke: el.getAttribute('stroke') || '',
      strokeDasharray: el.getAttribute('stroke-dasharray'),
      markerEnd: el.getAttribute('marker-end'),
      opacity: el.getAttribute('stroke-opacity'),
    }));
  });
}

async function getArrowCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const layer = document.querySelector('#arrows-layer');
    return layer ? layer.children.length : 0;
  });
}

/** Screenshot a region spanning multiple provinces. */
async function screenshotRegion(page: import('@playwright/test').Page, provinces: string[]) {
  const clip = await page.evaluate((provs) => {
    const svg = document.querySelector('#map-container svg') as SVGSVGElement;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const prov of provs) {
      const group = svg.querySelector(`.province-group[data-province="${prov}"]`);
      if (!group) continue;
      for (const path of group.querySelectorAll(':scope > path')) {
        const b = (path as SVGGraphicsElement).getBBox();
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + b.height);
      }
    }
    const pad = 30;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const tl = svg.createSVGPoint();
    tl.x = minX;
    tl.y = minY;
    const br = svg.createSVGPoint();
    br.x = maxX;
    br.y = maxY;
    const stl = tl.matrixTransform(ctm);
    const sbr = br.matrixTransform(ctm);
    return {
      x: Math.max(0, stl.x),
      y: Math.max(0, stl.y),
      width: sbr.x - stl.x,
      height: sbr.y - stl.y,
    };
  }, provinces);
  if (!clip) throw new Error(`Could not compute clip for ${provinces.join(',')}`);
  return page.screenshot({ clip });
}

// ---------------------------------------------------------------------------
// Successful move: coast → coast (Army)
// ---------------------------------------------------------------------------

test('successful move: coast to coast army (bre → pic)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Army', power: 'France', province: 'bre' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'France', province: 'pic' }];
  const orders = [makeMove('France', 'bre', 'pic')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].strokeDasharray).toBeNull();
  expect(arrows[0].markerEnd).toBeTruthy();

  expect(await screenshotRegion(page, ['bre', 'pic'])).toMatchSnapshot(
    'success-coast-coast-army-bre-pic.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: coast → coast (Fleet)
// ---------------------------------------------------------------------------

test('successful move: coast to coast fleet (bre → pic)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'bre' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'pic' }];
  const orders = [makeMove('France', 'bre', 'pic')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].strokeDasharray).toBeNull();

  expect(await screenshotRegion(page, ['bre', 'pic'])).toMatchSnapshot(
    'success-coast-coast-fleet-bre-pic.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: coast → sea (Fleet)
// ---------------------------------------------------------------------------

test('successful move: coast to sea fleet (bre → mao)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'bre' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'mao' }];
  const orders = [makeMove('France', 'bre', 'mao')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].strokeDasharray).toBeNull();

  expect(await screenshotRegion(page, ['bre', 'mao'])).toMatchSnapshot(
    'success-coast-sea-fleet-bre-mao.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: sea → sea (Fleet)
// ---------------------------------------------------------------------------

test('successful move: sea to sea fleet (nth → nwg)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'nth' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'nwg' }];
  const orders = [makeMove('England', 'nth', 'nwg')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['nth', 'nwg'])).toMatchSnapshot(
    'success-sea-sea-fleet-nth-nwg.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: sea → coast (Fleet)
// ---------------------------------------------------------------------------

test('successful move: sea to coast fleet (nth → lon)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'nth' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'lon' }];
  const orders = [makeMove('England', 'nth', 'lon')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['nth', 'lon'])).toMatchSnapshot(
    'success-sea-coast-fleet-nth-lon.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: coast → inland (Army)
// ---------------------------------------------------------------------------

test('successful move: coast to inland army (mar → bur)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Army', power: 'France', province: 'mar' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'France', province: 'bur' }];
  const orders = [makeMove('France', 'mar', 'bur')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['mar', 'bur'])).toMatchSnapshot(
    'success-coast-inland-army-mar-bur.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: inland → coast (Army)
// ---------------------------------------------------------------------------

test('successful move: inland to coast army (bur → mar)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Army', power: 'France', province: 'bur' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'France', province: 'mar' }];
  const orders = [makeMove('France', 'bur', 'mar')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['bur', 'mar'])).toMatchSnapshot(
    'success-inland-coast-army-bur-mar.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: inland → inland (Army)
// ---------------------------------------------------------------------------

test('successful move: inland to inland army (mun → boh)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Army', power: 'Germany', province: 'mun' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'Germany', province: 'boh' }];
  const orders = [makeMove('Germany', 'mun', 'boh')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['mun', 'boh'])).toMatchSnapshot(
    'success-inland-inland-army-mun-boh.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: bicoastal → sea (Fleet, stp/sc → bot)
// ---------------------------------------------------------------------------

test('successful move: bicoastal to sea fleet (stp/sc → bot)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'bot' }];
  const orders = [makeMove('Russia', 'stp', 'bot')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['stp', 'bot'])).toMatchSnapshot(
    'success-bicoastal-sea-fleet-stp-bot.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: sea → bicoastal (Fleet, bot → stp/sc)
// ---------------------------------------------------------------------------

test('successful move: sea to bicoastal fleet (bot → stp/sc)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'bot' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' }];
  const orders = [makeMove('Russia', 'bot', 'stp', 'Succeeds', 'sc')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['bot', 'stp'])).toMatchSnapshot(
    'success-sea-bicoastal-fleet-bot-stp.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Successful move: bicoastal → coast (Fleet, spa/nc → por)
// ---------------------------------------------------------------------------

test('successful move: bicoastal to coast fleet (spa/nc → por)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'spa', coast: 'nc' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'por' }];
  const orders = [makeMove('France', 'spa', 'por')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  expect(await screenshotRegion(page, ['spa', 'por'])).toMatchSnapshot(
    'success-bicoastal-coast-fleet-spa-por.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Arrow color is black for successful moves
// ---------------------------------------------------------------------------

test('arrow uses black color for successful move', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [{ type: 'Army', power: 'England', province: 'lvp' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'England', province: 'yor' }];
  const orders = [makeMove('England', 'lvp', 'yor')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].stroke).toBe('#000000');

  expect(await screenshotRegion(page, ['lvp', 'yor'])).toMatchSnapshot(
    'success-color-england-lvp-yor.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Multiple simultaneous successful moves
// ---------------------------------------------------------------------------

test('multiple successful moves render separate arrows', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'par' },
    { type: 'Army', power: 'Germany', province: 'mun' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bur' },
    { type: 'Army', power: 'Germany', province: 'boh' },
  ];
  const orders = [makeMove('France', 'par', 'bur'), makeMove('Germany', 'mun', 'boh')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const count = await getArrowCount(page);
  expect(count).toBe(2);

  expect(await screenshotRegion(page, ['par', 'bur', 'mun', 'boh'])).toMatchSnapshot(
    'success-multiple-moves.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// No arrows on Diplomacy phase (no turnRecord)
// ---------------------------------------------------------------------------

test('no arrows on Diplomacy phase', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  server.setSnapshot(
    makeSnapshot([{ type: 'Army', power: 'France', province: 'par' }], STARTING_SC, {
      year: 1901,
      season: 'Spring',
      type: 'Diplomacy',
    }),
  );
  await page.waitForTimeout(500);

  const count = await getArrowCount(page);
  expect(count).toBe(0);
});

// ---------------------------------------------------------------------------
// Hold orders produce no arrows
// ---------------------------------------------------------------------------

test('hold orders produce no arrows', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const units: TestUnit[] = [{ type: 'Army', power: 'France', province: 'par' }];
  const orders = [makeHold('France', 'par')];

  const snap = makeOrdersSnapshot(units, orders);
  server.setSnapshots([makeSnapshot(units), snap]);
  await page.evaluate(() => {
    const s = document.querySelector('#phase-slider') as HTMLInputElement;
    s.value = '1';
    s.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(500);

  const count = await getArrowCount(page);
  expect(count).toBe(0);
});
