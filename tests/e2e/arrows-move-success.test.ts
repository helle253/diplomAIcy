import { expect, test } from '@playwright/test';

import {
  getArrowCount,
  getArrows,
  getRegionClip,
  gotoAndWaitForMap,
  setupArrowScenario,
} from './arrow-helpers.js';
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
// Successful move: coast → coast (Army)
// ---------------------------------------------------------------------------

test('successful move: coast to coast army (bre → pic)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Army', power: 'France', province: 'bre' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'France', province: 'pic' }];
  const orders = [makeMove('France', 'bre', 'pic')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].strokeDasharray).toBeNull();
  expect(arrows[0].markerEnd).toBeTruthy();

  const clip = await getRegionClip(page, ['bre', 'pic']);
  await expect(page).toHaveScreenshot('success-coast-coast-army-bre-pic.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: coast → coast (Fleet)
// ---------------------------------------------------------------------------

test('successful move: coast to coast fleet (bre → pic)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'bre' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'pic' }];
  const orders = [makeMove('France', 'bre', 'pic')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].strokeDasharray).toBeNull();

  const clip = await getRegionClip(page, ['bre', 'pic']);
  await expect(page).toHaveScreenshot('success-coast-coast-fleet-bre-pic.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: coast → sea (Fleet)
// ---------------------------------------------------------------------------

test('successful move: coast to sea fleet (bre → mao)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'bre' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'mao' }];
  const orders = [makeMove('France', 'bre', 'mao')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].strokeDasharray).toBeNull();

  const clip = await getRegionClip(page, ['bre', 'mao']);
  await expect(page).toHaveScreenshot('success-coast-sea-fleet-bre-mao.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: sea → sea (Fleet)
// ---------------------------------------------------------------------------

test('successful move: sea to sea fleet (nth → nwg)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'nth' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'nwg' }];
  const orders = [makeMove('England', 'nth', 'nwg')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['nth', 'nwg']);
  await expect(page).toHaveScreenshot('success-sea-sea-fleet-nth-nwg.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: sea → coast (Fleet)
// ---------------------------------------------------------------------------

test('successful move: sea to coast fleet (nth → lon)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'nth' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'England', province: 'lon' }];
  const orders = [makeMove('England', 'nth', 'lon')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['nth', 'lon']);
  await expect(page).toHaveScreenshot('success-sea-coast-fleet-nth-lon.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: coast → inland (Army)
// ---------------------------------------------------------------------------

test('successful move: coast to inland army (mar → bur)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Army', power: 'France', province: 'mar' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'France', province: 'bur' }];
  const orders = [makeMove('France', 'mar', 'bur')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['mar', 'bur']);
  await expect(page).toHaveScreenshot('success-coast-inland-army-mar-bur.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: inland → coast (Army)
// ---------------------------------------------------------------------------

test('successful move: inland to coast army (bur → mar)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Army', power: 'France', province: 'bur' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'France', province: 'mar' }];
  const orders = [makeMove('France', 'bur', 'mar')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['bur', 'mar']);
  await expect(page).toHaveScreenshot('success-inland-coast-army-bur-mar.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: inland → inland (Army)
// ---------------------------------------------------------------------------

test('successful move: inland to inland army (mun → boh)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Army', power: 'Germany', province: 'mun' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'Germany', province: 'boh' }];
  const orders = [makeMove('Germany', 'mun', 'boh')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['mun', 'boh']);
  await expect(page).toHaveScreenshot('success-inland-inland-army-mun-boh.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: bicoastal → sea (Fleet, stp/sc → bot)
// ---------------------------------------------------------------------------

test('successful move: bicoastal to sea fleet (stp/sc → bot)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'bot' }];
  const orders = [makeMove('Russia', 'stp', 'bot')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['stp', 'bot']);
  await expect(page).toHaveScreenshot('success-bicoastal-sea-fleet-stp-bot.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: sea → bicoastal (Fleet, bot → stp/sc)
// ---------------------------------------------------------------------------

test('successful move: sea to bicoastal fleet (bot → stp/sc)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'bot' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' }];
  const orders = [makeMove('Russia', 'bot', 'stp', 'Succeeds', 'sc')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['bot', 'stp']);
  await expect(page).toHaveScreenshot('success-sea-bicoastal-fleet-bot-stp.png', { clip });
});

// ---------------------------------------------------------------------------
// Successful move: bicoastal → coast (Fleet, spa/nc → por)
// ---------------------------------------------------------------------------

test('successful move: bicoastal to coast fleet (spa/nc → por)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'spa', coast: 'nc' }];
  const after: TestUnit[] = [{ type: 'Fleet', power: 'France', province: 'por' }];
  const orders = [makeMove('France', 'spa', 'por')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');

  const clip = await getRegionClip(page, ['spa', 'por']);
  await expect(page).toHaveScreenshot('success-bicoastal-coast-fleet-spa-por.png', { clip });
});

// ---------------------------------------------------------------------------
// Arrow color is black for successful moves
// ---------------------------------------------------------------------------

test('arrow uses black color for successful move', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [{ type: 'Army', power: 'England', province: 'lvp' }];
  const after: TestUnit[] = [{ type: 'Army', power: 'England', province: 'yor' }];
  const orders = [makeMove('England', 'lvp', 'yor')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].stroke).toBe('#000000');

  const clip = await getRegionClip(page, ['lvp', 'yor']);
  await expect(page).toHaveScreenshot('success-color-england-lvp-yor.png', { clip });
});

// ---------------------------------------------------------------------------
// Multiple simultaneous successful moves
// ---------------------------------------------------------------------------

test('multiple successful moves render separate arrows', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'par' },
    { type: 'Army', power: 'Germany', province: 'mun' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bur' },
    { type: 'Army', power: 'Germany', province: 'boh' },
  ];
  const orders = [makeMove('France', 'par', 'bur'), makeMove('Germany', 'mun', 'boh')];

  await setupArrowScenario(page, server, before, after, orders, 2);

  const count = await getArrowCount(page);
  expect(count).toBe(2);

  const clip = await getRegionClip(page, ['par', 'bur', 'mun', 'boh']);
  await expect(page).toHaveScreenshot('success-multiple-moves.png', { clip });
});

// ---------------------------------------------------------------------------
// No arrows on phase without turnRecord
// ---------------------------------------------------------------------------

test('no arrows on phase without turnRecord', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  server.setSnapshot(
    makeSnapshot([{ type: 'Army', power: 'France', province: 'par' }], STARTING_SC, {
      year: 1901,
      season: 'Spring',
      type: 'Orders',
    }),
  );
  // Wait for the snapshot to be processed (units rendered)
  await page.waitForSelector('.unit-marker', { state: 'attached', timeout: 5_000 });

  const count = await getArrowCount(page);
  expect(count).toBe(0);
});

// ---------------------------------------------------------------------------
// Hold orders produce no arrows
// ---------------------------------------------------------------------------

test('hold orders produce no arrows', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const units: TestUnit[] = [{ type: 'Army', power: 'France', province: 'par' }];
  const orders = [makeHold('France', 'par')];

  const snap = makeOrdersSnapshot(units, orders);
  server.setSnapshots([makeSnapshot(units), snap]);
  await page.evaluate(() => {
    const s = document.querySelector('#phase-slider') as HTMLInputElement;
    s.value = '1';
    s.dispatchEvent(new Event('input'));
  });
  // Wait for the phase change to be processed
  await page.waitForSelector('#arrows-layer', { state: 'attached', timeout: 5_000 });

  const count = await getArrowCount(page);
  expect(count).toBe(0);
});
