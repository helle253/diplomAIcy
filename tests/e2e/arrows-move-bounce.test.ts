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
// Bounced move: coast → coast (Army) — bre → pic blocked
// ---------------------------------------------------------------------------

test('bounced move: coast to coast army (bre → pic)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bre' },
    { type: 'Army', power: 'England', province: 'pic' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'bre', 'pic', 'Fails'), makeHold('England', 'pic')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');
  expect(arrows[0].strokeDasharray).toBeNull();

  expect(await screenshotRegion(page, ['bre', 'pic'])).toMatchSnapshot(
    'bounce-coast-coast-army-bre-pic.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounced move: coast → sea (Fleet) — bre → eng blocked
// ---------------------------------------------------------------------------

test('bounced move: coast to sea fleet (bre → eng)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'France', province: 'bre' },
    { type: 'Fleet', power: 'England', province: 'eng' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'bre', 'eng', 'Fails'), makeHold('England', 'eng')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['bre', 'eng'])).toMatchSnapshot(
    'bounce-coast-sea-fleet-bre-eng.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounced move: sea → sea (Fleet) — nth → nwg blocked
// ---------------------------------------------------------------------------

test('bounced move: sea to sea fleet (nth → nwg)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'nth' },
    { type: 'Fleet', power: 'Russia', province: 'nwg' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('England', 'nth', 'nwg', 'Fails'), makeHold('Russia', 'nwg')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['nth', 'nwg'])).toMatchSnapshot(
    'bounce-sea-sea-fleet-nth-nwg.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounced move: sea → coast (Fleet)
// ---------------------------------------------------------------------------

test('bounced move: sea to coast fleet (nth → lon)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'Germany', province: 'nth' },
    { type: 'Fleet', power: 'England', province: 'lon' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Germany', 'nth', 'lon', 'Fails'), makeHold('England', 'lon')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['nth', 'lon'])).toMatchSnapshot(
    'bounce-sea-coast-fleet-nth-lon.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounced move: coast → inland (Army)
// ---------------------------------------------------------------------------

test('bounced move: coast to inland army (mar → bur)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'mar' },
    { type: 'Army', power: 'Germany', province: 'bur' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'mar', 'bur', 'Fails'), makeHold('Germany', 'bur')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['mar', 'bur'])).toMatchSnapshot(
    'bounce-coast-inland-army-mar-bur.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounced move: inland → coast (Army)
// ---------------------------------------------------------------------------

test('bounced move: inland to coast army (bur → mar)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'Germany', province: 'bur' },
    { type: 'Army', power: 'France', province: 'mar' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Germany', 'bur', 'mar', 'Fails'), makeHold('France', 'mar')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['bur', 'mar'])).toMatchSnapshot(
    'bounce-inland-coast-army-bur-mar.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounced move: inland → inland (Army)
// ---------------------------------------------------------------------------

test('bounced move: inland to inland army (mun → boh)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'Germany', province: 'mun' },
    { type: 'Army', power: 'Austria', province: 'boh' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Germany', 'mun', 'boh', 'Fails'), makeHold('Austria', 'boh')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['mun', 'boh'])).toMatchSnapshot(
    'bounce-inland-inland-army-mun-boh.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounced move: bicoastal → sea (Fleet, stp/sc → bot)
// ---------------------------------------------------------------------------

test('bounced move: bicoastal to sea fleet (stp/sc → bot)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' },
    { type: 'Fleet', power: 'Germany', province: 'bot' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Russia', 'stp', 'bot', 'Fails'), makeHold('Germany', 'bot')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['stp', 'bot'])).toMatchSnapshot(
    'bounce-bicoastal-sea-fleet-stp-bot.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Bounce arrow is red
// ---------------------------------------------------------------------------

test('bounce arrow is red', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'par' },
    { type: 'Army', power: 'Germany', province: 'bur' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'par', 'bur', 'Fails'), makeHold('Germany', 'bur')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['par', 'bur'])).toMatchSnapshot(
    'bounce-red-army-par-bur.png',
    { maxDiffPixelRatio: 0.01 },
  );
});
