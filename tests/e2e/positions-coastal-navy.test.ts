import { expect, test } from '@playwright/test';

import { makeSnapshot, startTestServer, type TestServer, type TestUnit } from './test-server.js';

let server: TestServer;
test.beforeAll(async () => {
  server = await startTestServer([makeSnapshot([])]);
});
test.afterAll(async () => {
  await server.close();
});

async function getUnitPositionData(page: import('@playwright/test').Page, province: string) {
  return page.evaluate((prov) => {
    const svg = document.querySelector('svg')!;
    const group = svg.querySelector(`.province-group[data-province="${prov}"]`)!;

    // Province path bounding box
    const paths = group.querySelectorAll(':scope > path');
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const path of paths) {
      const b = (path as SVGGraphicsElement).getBBox();
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }

    // Unit marker position (only 1 unit on map)
    const marker = svg.querySelector('.unit-marker')!;
    const circle = marker.querySelector('circle')!;
    const unitCX = parseFloat(circle.getAttribute('cx')!);
    const unitCY = parseFloat(circle.getAttribute('cy')!);

    return { unitCX, unitCY, bbox: { minX, minY, maxX, maxY } };
  }, province);
}

async function screenshotProvince(page: import('@playwright/test').Page, province: string) {
  const clip = await page.evaluate((prov) => {
    const svg = document.querySelector('#map-container svg') as SVGSVGElement;
    const group = svg.querySelector(`.province-group[data-province="${prov}"]`);
    if (!group) return null;
    const paths = group.querySelectorAll(':scope > path');
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const path of paths) {
      const b = (path as SVGGraphicsElement).getBBox();
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    const pad = 20;
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
  }, province);
  if (!clip) throw new Error(`Could not compute clip for ${province}`);
  return page.screenshot({ clip });
}

const COASTAL_PROVINCES = [
  'lon',
  'edi',
  'lvp',
  'cly',
  'wal',
  'yor',
  'bre',
  'mar',
  'pic',
  'gas',
  'ber',
  'kie',
  'rom',
  'nap',
  'ven',
  'pie',
  'tus',
  'apu',
  'tri',
  'sev',
  'lvn',
  'fin',
  'con',
  'ank',
  'smy',
  'arm',
  'syr',
  'nor',
  'swe',
  'den',
  'hol',
  'bel',
  'por',
  'tun',
  'rum',
  'gre',
  'naf',
  'alb',
  'pru',
];

test.describe('Coastal provinces — fleet placement', () => {
  for (const prov of COASTAL_PROVINCES) {
    test(prov, async ({ page }) => {
      const unit: TestUnit = { type: 'Fleet', power: 'England', province: prov };
      server.setSnapshot(makeSnapshot([unit]));
      await page.goto(server.url);
      await page.waitForSelector('.unit-marker', { state: 'attached', timeout: 10_000 });
      await page.waitForTimeout(500);

      const d = await getUnitPositionData(page, prov);
      const margin = 15;

      // 1. Within bounds
      expect(d.unitCX, `${prov} Fleet x within bounds`).toBeGreaterThanOrEqual(
        d.bbox.minX - margin,
      );
      expect(d.unitCX, `${prov} Fleet x within bounds`).toBeLessThanOrEqual(d.bbox.maxX + margin);
      expect(d.unitCY, `${prov} Fleet y within bounds`).toBeGreaterThanOrEqual(
        d.bbox.minY - margin,
      );
      expect(d.unitCY, `${prov} Fleet y within bounds`).toBeLessThanOrEqual(d.bbox.maxY + margin);

      const screenshot = await screenshotProvince(page, prov);
      expect(screenshot).toMatchSnapshot(`${prov}-fleet.png`, {
        maxDiffPixels: 12,
      });
    });
  }
});
