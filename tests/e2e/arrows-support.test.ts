import { expect, test } from '@playwright/test';

import {
  makeHold,
  makeMove,
  makeOrdersSnapshot,
  makeSnapshot,
  makeSupport,
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

async function getSupportArrows(page: import('@playwright/test').Page): Promise<ArrowInfo[]> {
  const all = await getArrows(page);
  return all.filter((a) => a.strokeDasharray !== null);
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
// Support-to-move: coast army supports coast army move (pic S bre → bur)
// ---------------------------------------------------------------------------

test('support-to-move: coast army supports coast army (pic S bre → bur)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bre' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bur' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const orders = [makeMove('France', 'bre', 'bur'), makeSupport('France', 'pic', 'bre', 'bur')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const all = await getArrows(page);
  // move arrow (line) + support path + support circle = 3
  const dashed = all.filter((a) => a.strokeDasharray !== null);
  expect(dashed).toHaveLength(1);
  expect(dashed[0].tag).toBe('path');
  expect(dashed[0].stroke).toBe('#000000');
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  expect(await screenshotRegion(page, ['bre', 'pic', 'bur'])).toMatchSnapshot(
    'support-move-coast-army-pic-bre-bur.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Support-to-hold: coast army supports inland army hold (pic S bur)
// ---------------------------------------------------------------------------

test('support-to-hold: coast army supports inland army hold (pic S bur)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const units: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'pic' },
    { type: 'Army', power: 'France', province: 'bur' },
  ];
  const orders = [makeSupport('France', 'pic', 'bur', undefined), makeHold('France', 'bur')];

  await setupArrowScenario(page, units, units, orders);
  await page.waitForTimeout(500);

  const all = await getArrows(page);
  const dashedLines = all.filter((a) => a.tag === 'line' && a.strokeDasharray !== null);
  expect(dashedLines).toHaveLength(1);
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  expect(await screenshotRegion(page, ['pic', 'bur'])).toMatchSnapshot(
    'support-hold-coast-army-pic-bur.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Support from sea: fleet supports army move (eng S lon → wal)
// ---------------------------------------------------------------------------

test('support from sea: fleet supports army move (eng S lon → wal)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'eng' },
    { type: 'Army', power: 'England', province: 'lon' },
  ];
  const after: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'eng' },
    { type: 'Army', power: 'England', province: 'wal' },
  ];
  const orders = [makeSupport('England', 'eng', 'lon', 'wal'), makeMove('England', 'lon', 'wal')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  expect(await screenshotRegion(page, ['eng', 'lon', 'wal'])).toMatchSnapshot(
    'support-sea-fleet-eng-lon-wal.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Support from inland: army supports army move (boh S mun → tyr)
// ---------------------------------------------------------------------------

test('support from inland: army supports army move (boh S mun → tyr)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'Austria', province: 'boh' },
    { type: 'Army', power: 'Austria', province: 'mun' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'Austria', province: 'boh' },
    { type: 'Army', power: 'Austria', province: 'tyr' },
  ];
  const orders = [makeSupport('Austria', 'boh', 'mun', 'tyr'), makeMove('Austria', 'mun', 'tyr')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  expect(await screenshotRegion(page, ['boh', 'mun', 'tyr'])).toMatchSnapshot(
    'support-inland-army-boh-mun-tyr.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Support from coast: fleet supports fleet move (lon S nth → eng)
// ---------------------------------------------------------------------------

test('support from coast: fleet supports fleet move (lon S nth → eng)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'lon' },
    { type: 'Fleet', power: 'England', province: 'nth' },
  ];
  const after: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'lon' },
    { type: 'Fleet', power: 'England', province: 'eng' },
  ];
  const orders = [makeSupport('England', 'lon', 'nth', 'eng'), makeMove('England', 'nth', 'eng')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  expect(await screenshotRegion(page, ['lon', 'nth', 'eng'])).toMatchSnapshot(
    'support-coast-fleet-lon-nth-eng.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Disrupted support is red
// ---------------------------------------------------------------------------

test('disrupted support is red', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const units: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'pic' },
    { type: 'Army', power: 'France', province: 'bur' },
    { type: 'Army', power: 'Germany', province: 'bel' },
  ];
  const orders = [
    makeSupport('France', 'pic', 'bur', undefined, 'Fails'),
    makeHold('France', 'bur'),
    makeMove('Germany', 'bel', 'pic', 'Fails'),
  ];

  await setupArrowScenario(page, units, units, orders);
  await page.waitForTimeout(500);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1); // dashed line
  expect(supports[0].stroke).toBe('#cc0000');

  const all = await getArrows(page);
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);
  expect(circles[0].stroke).toBe('#cc0000');

  expect(await screenshotRegion(page, ['pic', 'bur', 'bel'])).toMatchSnapshot(
    'support-failed-pic-bur-bel.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Support from bicoastal: fleet at stp/sc supports move (bot → fin)
// ---------------------------------------------------------------------------

test('support from bicoastal: fleet stp/sc supports move (bot → fin)', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' },
    { type: 'Fleet', power: 'Russia', province: 'bot' },
  ];
  const after: TestUnit[] = [
    { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' },
    { type: 'Fleet', power: 'Russia', province: 'fin' },
  ];
  const orders = [makeSupport('Russia', 'stp', 'bot', 'fin'), makeMove('Russia', 'bot', 'fin')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  expect(await screenshotRegion(page, ['stp', 'bot', 'fin'])).toMatchSnapshot(
    'support-bicoastal-fleet-stp-bot-fin.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Mixed: successful move + support in same phase
// ---------------------------------------------------------------------------

test('mixed: move arrow and support arrow render together', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'par' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bur' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const orders = [makeMove('France', 'par', 'bur'), makeSupport('France', 'pic', 'par', 'bur')];

  await setupArrowScenario(page, before, after, orders);
  await page.waitForTimeout(500);

  const all = await getArrows(page);
  expect(all).toHaveLength(3); // move line + support path + support circle

  const dashed = all.filter((a) => a.strokeDasharray !== null);
  expect(dashed).toHaveLength(1); // support path
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  expect(await screenshotRegion(page, ['par', 'pic', 'bur'])).toMatchSnapshot(
    'mixed-move-support-par-pic-bur.png',
    { maxDiffPixelRatio: 0.01 },
  );
});

// ---------------------------------------------------------------------------
// Mixed: bounced move + support in same phase
// ---------------------------------------------------------------------------

test('mixed: bounce and support render together', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForTimeout(1500);

  const units: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'par' },
    { type: 'Army', power: 'France', province: 'pic' },
    { type: 'Army', power: 'Germany', province: 'bur' },
  ];
  const orders = [
    makeMove('France', 'par', 'bur', 'Fails'),
    makeSupport('France', 'pic', 'par', 'bur', 'Fails'),
    makeHold('Germany', 'bur'),
  ];

  await setupArrowScenario(page, units, units, orders);
  await page.waitForTimeout(500);

  const all = await getArrows(page);
  expect(all).toHaveLength(3); // bounce line + support path + support circle

  const dashed = all.filter((a) => a.strokeDasharray !== null);
  expect(dashed).toHaveLength(1);

  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  expect(await screenshotRegion(page, ['par', 'pic', 'bur'])).toMatchSnapshot(
    'mixed-bounce-support-par-pic-bur.png',
    { maxDiffPixelRatio: 0.01 },
  );
});
