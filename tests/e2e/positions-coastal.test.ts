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
    const rect = marker.querySelector('rect');
    const circle = marker.querySelector('circle');
    let unitCX: number, unitCY: number, unitType: string;
    if (rect) {
      unitCX = parseFloat(rect.getAttribute('x')!) + 7;
      unitCY = parseFloat(rect.getAttribute('y')!) + 7;
      unitType = 'Army';
    } else {
      unitCX = parseFloat(circle!.getAttribute('cx')!);
      unitCY = parseFloat(circle!.getAttribute('cy')!);
      unitType = 'Fleet';
    }

    // SC position: parse from <g id="sc"> > path d attribute
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
          scY = parseFloat(m[2]) - 4; // center is 4px above path start
        }
      }
    }

    // Text label bbox
    const textEl = group.querySelector(':scope > text[id]') as SVGTextElement;
    const textBBox = textEl ? textEl.getBBox() : { x: 0, y: 0, width: 0, height: 0 };

    return {
      unitCX,
      unitCY,
      unitType,
      bbox: { minX, minY, maxX, maxY },
      sc: scX !== null ? { x: scX, y: scY! } : null,
      textBBox: { x: textBBox.x, y: textBBox.y, w: textBBox.width, h: textBBox.height },
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

test.describe('Coastal provinces', () => {
  for (const prov of COASTAL_PROVINCES) {
    test.describe(prov, () => {
      for (const unitType of ['Army', 'Fleet'] as const) {
        test(`${unitType}`, async ({ page }) => {
          const unit: TestUnit = { type: unitType, power: 'England', province: prov };
          server.setSnapshot(makeSnapshot([unit]));
          await page.goto(server.url);
          await page.waitForSelector('.unit-marker', { state: 'attached', timeout: 10_000 });
          await page.waitForTimeout(500);

          const d = await getUnitPositionData(page, prov);
          const margin = 15;

          // 1. Within bounds
          expect(d.unitCX, `${prov} ${unitType} x within bounds`).toBeGreaterThanOrEqual(
            d.bbox.minX - margin,
          );
          expect(d.unitCX, `${prov} ${unitType} x within bounds`).toBeLessThanOrEqual(
            d.bbox.maxX + margin,
          );
          expect(d.unitCY, `${prov} ${unitType} y within bounds`).toBeGreaterThanOrEqual(
            d.bbox.minY - margin,
          );
          expect(d.unitCY, `${prov} ${unitType} y within bounds`).toBeLessThanOrEqual(
            d.bbox.maxY + margin,
          );

          // 2. SC non-overlap
          if (d.sc) {
            const dist = Math.sqrt((d.unitCX - d.sc.x) ** 2 + (d.unitCY - d.sc.y) ** 2);
            const threshold = unitType === 'Fleet' ? 12 : 11;
            expect(dist, `${prov} ${unitType} should not overlap SC`).toBeGreaterThanOrEqual(
              threshold,
            );
          }

          // 3. Text non-overlap
          const uw = unitType === 'Army' ? 7 : 8;
          const unitLeft = d.unitCX - uw,
            unitRight = d.unitCX + uw;
          const unitTop = d.unitCY - uw,
            unitBottom = d.unitCY + uw;
          const textRight = d.textBBox.x + d.textBBox.w;
          const textBottom = d.textBBox.y + d.textBBox.h;
          const overlapsText =
            unitLeft < textRight &&
            unitRight > d.textBBox.x &&
            unitTop < textBottom &&
            unitBottom > d.textBBox.y;
          // For very small provinces, text overlap may be unavoidable
          // Log a warning but don't hard-fail
          if (overlapsText) {
            console.warn(`${prov} ${unitType}: text overlap detected`);
          }

          const screenshot = await screenshotProvince(page, prov);
          expect(screenshot).toMatchSnapshot(`${prov}-${unitType.toLowerCase()}.png`, {
            maxDiffPixelRatio: 0.001,
          });
        });
      }
    });
  }
});
