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

    // Unit marker position
    const marker = svg.querySelector('.unit-marker')!;
    const rect = marker.querySelector('rect');
    const circle = marker.querySelector('circle');
    let unitCX: number, unitCY: number;
    if (rect) {
      unitCX = parseFloat(rect.getAttribute('x')!) + 7;
      unitCY = parseFloat(rect.getAttribute('y')!) + 7;
    } else {
      unitCX = parseFloat(circle!.getAttribute('cx')!);
      unitCY = parseFloat(circle!.getAttribute('cy')!);
    }

    // SC position
    const scGroup = group.querySelector(':scope > g[id="sc"]');
    let scX: number | null = null,
      scY: number | null = null;
    if (scGroup) {
      const scPath = scGroup.querySelector('path');
      if (scPath) {
        const d = scPath.getAttribute('d') || '';
        const m = d.match(/^m(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/);
        if (m) {
          scX = parseFloat(m[1]);
          scY = parseFloat(m[2]) - 4;
        }
      }
    }

    // Text label bbox
    const textEl = group.querySelector(':scope > text[id]') as SVGTextElement;
    const tb = textEl ? textEl.getBBox() : { x: 0, y: 0, width: 0, height: 0 };

    return {
      unitCX,
      unitCY,
      bbox: { minX, minY, maxX, maxY },
      sc: scX !== null ? { x: scX, y: scY! } : null,
      textBBox: { x: tb.x, y: tb.y, w: tb.width, h: tb.height },
    };
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

const BICOASTAL = ['stp', 'spa', 'bul'] as const;

for (const prov of BICOASTAL) {
  test.describe(`Bicoastal — ${prov}`, () => {
    // Test 1: Fleet on north coast
    test('Fleet/nc', async ({ page }) => {
      const unit: TestUnit = { type: 'Fleet', power: 'England', province: prov, coast: 'nc' };
      server.setSnapshot(makeSnapshot([unit]));
      await page.goto(server.url);
      await page.waitForSelector('.unit-marker circle, .unit-marker rect', {
        state: 'attached',
        timeout: 10_000,
      });
      const d = await getUnitPositionData(page, prov);
      expect(d.unitCX).toBeGreaterThanOrEqual(d.bbox.minX - 15);
      expect(d.unitCX).toBeLessThanOrEqual(d.bbox.maxX + 15);
      expect(d.unitCY).toBeGreaterThanOrEqual(d.bbox.minY - 15);
      expect(d.unitCY).toBeLessThanOrEqual(d.bbox.maxY + 15);
      if (d.sc) {
        const dist = Math.sqrt((d.unitCX - d.sc.x) ** 2 + (d.unitCY - d.sc.y) ** 2);
        expect(dist, 'fleet/nc should not overlap SC').toBeGreaterThanOrEqual(12);
      }
      const screenshot = await screenshotProvince(page, prov);
      expect(screenshot).toMatchSnapshot(`${prov}-fleet-nc.png`, {
        maxDiffPixelRatio: 0.01,
      });
    });

    // Test 3: Fleet on south coast
    test('Fleet/sc', async ({ page }) => {
      const unit: TestUnit = { type: 'Fleet', power: 'England', province: prov, coast: 'sc' };
      server.setSnapshot(makeSnapshot([unit]));
      await page.goto(server.url);
      await page.waitForSelector('.unit-marker circle, .unit-marker rect', {
        state: 'attached',
        timeout: 10_000,
      });
      const d = await getUnitPositionData(page, prov);
      expect(d.unitCX).toBeGreaterThanOrEqual(d.bbox.minX - 15);
      expect(d.unitCX).toBeLessThanOrEqual(d.bbox.maxX + 15);
      expect(d.unitCY).toBeGreaterThanOrEqual(d.bbox.minY - 15);
      expect(d.unitCY).toBeLessThanOrEqual(d.bbox.maxY + 15);
      if (d.sc) {
        const dist = Math.sqrt((d.unitCX - d.sc.x) ** 2 + (d.unitCY - d.sc.y) ** 2);
        expect(dist, 'fleet/sc should not overlap SC').toBeGreaterThanOrEqual(12);
      }
      const screenshot = await screenshotProvince(page, prov);
      expect(screenshot).toMatchSnapshot(`${prov}-fleet-sc.png`, {
        maxDiffPixelRatio: 0.01,
      });
    });

    // Test 4: nc fleet is north of sc fleet
    test('Fleet/nc is north of Fleet/sc', async ({ page }) => {
      // Place nc fleet, get position
      const ncUnit: TestUnit = { type: 'Fleet', power: 'England', province: prov, coast: 'nc' };
      server.setSnapshot(makeSnapshot([ncUnit]));
      await page.goto(server.url);
      await page.waitForSelector('.unit-marker circle, .unit-marker rect', {
        state: 'attached',
        timeout: 10_000,
      });
      const ncPos = await page.evaluate(() => {
        const marker = document.querySelector('.unit-marker')!;
        const circle = marker.querySelector('circle');
        const rect = marker.querySelector('rect');
        if (circle)
          return {
            x: parseFloat(circle.getAttribute('cx')!),
            y: parseFloat(circle.getAttribute('cy')!),
          };
        return {
          x: parseFloat(rect!.getAttribute('x')!) + 7,
          y: parseFloat(rect!.getAttribute('y')!) + 7,
        };
      });

      // Place sc fleet, get position
      const scUnit: TestUnit = { type: 'Fleet', power: 'England', province: prov, coast: 'sc' };
      server.setSnapshot(makeSnapshot([scUnit]));
      await page.goto(server.url);
      await page.waitForSelector('.unit-marker circle, .unit-marker rect', {
        state: 'attached',
        timeout: 10_000,
      });
      const scPos = await page.evaluate(() => {
        const marker = document.querySelector('.unit-marker')!;
        const circle = marker.querySelector('circle');
        const rect = marker.querySelector('rect');
        if (circle)
          return {
            x: parseFloat(circle.getAttribute('cx')!),
            y: parseFloat(circle.getAttribute('cy')!),
          };
        return {
          x: parseFloat(rect!.getAttribute('x')!) + 7,
          y: parseFloat(rect!.getAttribute('y')!) + 7,
        };
      });

      // NC should be above (lower y) or northwest of SC in SVG coordinates
      // For stp: nc is toward Barents (north), sc toward Bothnia (south)
      // For spa: nc is toward Biscay (north), sc toward Med (south)
      // For bul: nc is toward Black Sea (east/north), sc toward Aegean (south)
      expect(ncPos.y, 'nc fleet should be north of sc fleet').toBeLessThan(scPos.y);

      // They should not overlap each other (centers >16px apart)
      const dist = Math.sqrt((ncPos.x - scPos.x) ** 2 + (ncPos.y - scPos.y) ** 2);
      expect(dist, 'nc and sc fleets should not overlap').toBeGreaterThanOrEqual(16);
    });
  });
}
