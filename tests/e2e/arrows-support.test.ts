import { expect, test } from '@playwright/test';

import {
  getArrows,
  getRegionClip,
  getSupportArrows,
  gotoAndWaitForMap,
  setupArrowScenario,
} from './arrow-helpers.js';
import {
  makeHold,
  makeMove,
  makeSnapshot,
  makeSupport,
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
// Support-to-move: coast army supports coast army move (pic S bre → bur)
// ---------------------------------------------------------------------------

test('support-to-move: coast army supports coast army (pic S bre → bur)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bre' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bur' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const orders = [makeMove('France', 'bre', 'bur'), makeSupport('France', 'pic', 'bre', 'bur')];

  // move arrow (line) + support path + support circle = 3
  await setupArrowScenario(page, server, before, after, orders, 3);

  const all = await getArrows(page);
  const dashed = all.filter((a) => a.strokeDasharray !== null);
  expect(dashed).toHaveLength(1);
  expect(dashed[0].tag).toBe('path');
  expect(dashed[0].stroke).toBe('#000000');
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  const clip = await getRegionClip(page, ['bre', 'pic', 'bur']);
  await expect(page).toHaveScreenshot('support-move-coast-army-pic-bre-bur.png', { clip });
});

// ---------------------------------------------------------------------------
// Support-to-hold: coast army supports inland army hold (pic S bur)
// ---------------------------------------------------------------------------

test('support-to-hold: coast army supports inland army hold (pic S bur)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const units: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'pic' },
    { type: 'Army', power: 'France', province: 'bur' },
  ];
  const orders = [makeSupport('France', 'pic', 'bur', undefined), makeHold('France', 'bur')];

  // support-to-hold: dashed line + circle = 2
  await setupArrowScenario(page, server, units, units, orders, 2);

  const all = await getArrows(page);
  const dashedLines = all.filter((a) => a.tag === 'line' && a.strokeDasharray !== null);
  expect(dashedLines).toHaveLength(1);
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  const clip = await getRegionClip(page, ['pic', 'bur']);
  await expect(page).toHaveScreenshot('support-hold-coast-army-pic-bur.png', { clip });
});

// ---------------------------------------------------------------------------
// Support from sea: fleet supports army move (eng S lon → wal)
// ---------------------------------------------------------------------------

test('support from sea: fleet supports army move (eng S lon → wal)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'eng' },
    { type: 'Army', power: 'England', province: 'lon' },
  ];
  const after: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'eng' },
    { type: 'Army', power: 'England', province: 'wal' },
  ];
  const orders = [makeSupport('England', 'eng', 'lon', 'wal'), makeMove('England', 'lon', 'wal')];

  // move arrow + support path + support circle = 3
  await setupArrowScenario(page, server, before, after, orders, 3);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  const clip = await getRegionClip(page, ['eng', 'lon', 'wal']);
  await expect(page).toHaveScreenshot('support-sea-fleet-eng-lon-wal.png', { clip });
});

// ---------------------------------------------------------------------------
// Support from inland: army supports army move (boh S mun → tyr)
// ---------------------------------------------------------------------------

test('support from inland: army supports army move (boh S mun → tyr)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'Austria', province: 'boh' },
    { type: 'Army', power: 'Austria', province: 'mun' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'Austria', province: 'boh' },
    { type: 'Army', power: 'Austria', province: 'tyr' },
  ];
  const orders = [makeSupport('Austria', 'boh', 'mun', 'tyr'), makeMove('Austria', 'mun', 'tyr')];

  // move arrow + support path + support circle = 3
  await setupArrowScenario(page, server, before, after, orders, 3);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  const clip = await getRegionClip(page, ['boh', 'mun', 'tyr']);
  await expect(page).toHaveScreenshot('support-inland-army-boh-mun-tyr.png', { clip });
});

// ---------------------------------------------------------------------------
// Support from coast: fleet supports fleet move (lon S nth → eng)
// ---------------------------------------------------------------------------

test('support from coast: fleet supports fleet move (lon S nth → eng)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'lon' },
    { type: 'Fleet', power: 'England', province: 'nth' },
  ];
  const after: TestUnit[] = [
    { type: 'Fleet', power: 'England', province: 'lon' },
    { type: 'Fleet', power: 'England', province: 'eng' },
  ];
  const orders = [makeSupport('England', 'lon', 'nth', 'eng'), makeMove('England', 'nth', 'eng')];

  // move arrow + support path + support circle = 3
  await setupArrowScenario(page, server, before, after, orders, 3);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  const clip = await getRegionClip(page, ['lon', 'nth', 'eng']);
  await expect(page).toHaveScreenshot('support-coast-fleet-lon-nth-eng.png', { clip });
});

// ---------------------------------------------------------------------------
// Disrupted support is red
// ---------------------------------------------------------------------------

test('disrupted support is red', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

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

  // support line + support circle + bounce arrow = 3
  await setupArrowScenario(page, server, units, units, orders, 3);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1); // dashed line
  expect(supports[0].stroke).toBe('#cc0000');

  const all = await getArrows(page);
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);
  expect(circles[0].stroke).toBe('#cc0000');

  const clip = await getRegionClip(page, ['pic', 'bur', 'bel']);
  await expect(page).toHaveScreenshot('support-failed-pic-bur-bel.png', { clip });
});

// ---------------------------------------------------------------------------
// Support from bicoastal: fleet at stp/sc supports move (bot → fin)
// ---------------------------------------------------------------------------

test('support from bicoastal: fleet stp/sc supports move (bot → fin)', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' },
    { type: 'Fleet', power: 'Russia', province: 'bot' },
  ];
  const after: TestUnit[] = [
    { type: 'Fleet', power: 'Russia', province: 'stp', coast: 'sc' },
    { type: 'Fleet', power: 'Russia', province: 'fin' },
  ];
  const orders = [makeSupport('Russia', 'stp', 'bot', 'fin'), makeMove('Russia', 'bot', 'fin')];

  // move arrow + support path + support circle = 3
  await setupArrowScenario(page, server, before, after, orders, 3);

  const supports = await getSupportArrows(page);
  expect(supports).toHaveLength(1);
  expect(supports[0].tag).toBe('path');
  expect(supports[0].strokeDasharray).toBe('6,4');

  const clip = await getRegionClip(page, ['stp', 'bot', 'fin']);
  await expect(page).toHaveScreenshot('support-bicoastal-fleet-stp-bot-fin.png', { clip });
});

// ---------------------------------------------------------------------------
// Mixed: successful move + support in same phase
// ---------------------------------------------------------------------------

test('mixed: move arrow and support arrow render together', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

  const before: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'par' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const after: TestUnit[] = [
    { type: 'Army', power: 'France', province: 'bur' },
    { type: 'Army', power: 'France', province: 'pic' },
  ];
  const orders = [makeMove('France', 'par', 'bur'), makeSupport('France', 'pic', 'par', 'bur')];

  // move line + support path + support circle = 3
  await setupArrowScenario(page, server, before, after, orders, 3);

  const all = await getArrows(page);
  expect(all).toHaveLength(3);

  const dashed = all.filter((a) => a.strokeDasharray !== null);
  expect(dashed).toHaveLength(1); // support path
  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  const clip = await getRegionClip(page, ['par', 'pic', 'bur']);
  await expect(page).toHaveScreenshot('mixed-move-support-par-pic-bur.png', { clip });
});

// ---------------------------------------------------------------------------
// Mixed: bounced move + support in same phase
// ---------------------------------------------------------------------------

test('mixed: bounce and support render together', async ({ page }) => {
  await gotoAndWaitForMap(page, server.url);

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

  // bounce line + support path + support circle = 3
  await setupArrowScenario(page, server, units, units, orders, 3);

  const all = await getArrows(page);
  expect(all).toHaveLength(3);

  const dashed = all.filter((a) => a.strokeDasharray !== null);
  expect(dashed).toHaveLength(1);

  const circles = all.filter((a) => a.tag === 'circle');
  expect(circles).toHaveLength(1);

  const clip = await getRegionClip(page, ['par', 'pic', 'bur']);
  await expect(page).toHaveScreenshot('mixed-bounce-support-par-pic-bur.png', { clip });
});
