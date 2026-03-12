import { expect, test } from '@playwright/test';

import {
  getArrows,
  getRegionClip,
  gotoAndWaitForMap,
  setupArrowScenario,
} from './arrow-helpers.js';
import {
  makeHold,
  makeMove,
  makeSnapshot,
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
// Bounced move: coast → coast (Army) — bre → pic blocked
// ---------------------------------------------------------------------------

test('bounced move: coast to coast army (bre → pic)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bre' },
    { type: 'Army', power: 'England', province: 'pic' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'bre', 'pic', 'Fails'), makeHold('England', 'pic')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');
  expect(arrows[0].strokeDasharray).toBeNull();

  const clip = await getRegionClip(page, ['bre', 'pic']);
  await expect(page).toHaveScreenshot('bounce-coast-coast-army-bre-pic.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounced move: coast → sea (Fleet) — bre → eng blocked
// ---------------------------------------------------------------------------

test('bounced move: coast to sea fleet (bre → eng)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'France', province: 'bre' },
    { type: 'Fleet', power: 'England', province: 'eng' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'bre', 'eng', 'Fails'), makeHold('England', 'eng')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['bre', 'eng']);
  await expect(page).toHaveScreenshot('bounce-coast-sea-fleet-bre-eng.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounced move: sea → sea (Fleet) — nth → nwg blocked
// ---------------------------------------------------------------------------

test('bounced move: sea to sea fleet (nth → nwg)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'nth' },
    { type: 'Fleet', power: 'Russia', province: 'nwg' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('England', 'nth', 'nwg', 'Fails'), makeHold('Russia', 'nwg')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['nth', 'nwg']);
  await expect(page).toHaveScreenshot('bounce-sea-sea-fleet-nth-nwg.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounced move: sea → coast (Fleet)
// ---------------------------------------------------------------------------

test('bounced move: sea to coast fleet (nth → lon)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'Germany', province: 'nth' },
    { type: 'Fleet', power: 'England', province: 'lon' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Germany', 'nth', 'lon', 'Fails'), makeHold('England', 'lon')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['nth', 'lon']);
  await expect(page).toHaveScreenshot('bounce-sea-coast-fleet-nth-lon.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounced move: coast → inland (Army)
// ---------------------------------------------------------------------------

test('bounced move: coast to inland army (mar → bur)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'mar' },
    { type: 'Army', power: 'Germany', province: 'bur' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'mar', 'bur', 'Fails'), makeHold('Germany', 'bur')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['mar', 'bur']);
  await expect(page).toHaveScreenshot('bounce-coast-inland-army-mar-bur.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounced move: inland → coast (Army)
// ---------------------------------------------------------------------------

test('bounced move: inland to coast army (bur → mar)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'Germany', province: 'bur' },
    { type: 'Army', power: 'France', province: 'mar' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Germany', 'bur', 'mar', 'Fails'), makeHold('France', 'mar')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['bur', 'mar']);
  await expect(page).toHaveScreenshot('bounce-inland-coast-army-bur-mar.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounced move: inland → inland (Army)
// ---------------------------------------------------------------------------

test('bounced move: inland to inland army (mun → boh)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'Germany', province: 'mun' },
    { type: 'Army', power: 'Austria', province: 'boh' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Germany', 'mun', 'boh', 'Fails'), makeHold('Austria', 'boh')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['mun', 'boh']);
  await expect(page).toHaveScreenshot('bounce-inland-inland-army-mun-boh.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounced move: bicoastal → sea (Fleet, stp/sc → bot)
// ---------------------------------------------------------------------------

test('bounced move: bicoastal to sea fleet (stp/sc → bot)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' },
    { type: 'Fleet', power: 'Germany', province: 'bot' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('Russia', 'stp', 'bot', 'Fails'), makeHold('Germany', 'bot')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].tag).toBe('line');
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['stp', 'bot']);
  await expect(page).toHaveScreenshot('bounce-bicoastal-sea-fleet-stp-bot.png', { clip });
});

// ---------------------------------------------------------------------------
// Bounce arrow is red
// ---------------------------------------------------------------------------

test('bounce arrow is red', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'par' },
    { type: 'Army', power: 'Germany', province: 'bur' },
  ];
  const after: TestUnit[] = [...before];
  const orders = [makeMove('France', 'par', 'bur', 'Fails'), makeHold('Germany', 'bur')];

  await setupArrowScenario(page, server, before, after, orders, 1);

  const arrows = await getArrows(page);
  expect(arrows).toHaveLength(1);
  expect(arrows[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['par', 'bur']);
  await expect(page).toHaveScreenshot('bounce-red-army-par-bur.png', { clip });
});
