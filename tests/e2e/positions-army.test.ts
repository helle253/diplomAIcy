import { expect, test } from '@playwright/test';

import { makeSnapshot, startTestServer, type TestServer, type TestUnit } from './test-server.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer([makeSnapshot([])]);
});

test.afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// Province lists
// ---------------------------------------------------------------------------

const LAND_PROVINCES = [
  // Inland
  'par',
  'bur',
  'mun',
  'ruh',
  'sil',
  'vie',
  'bud',
  'boh',
  'gal',
  'tyr',
  'mos',
  'war',
  'ukr',
  'ser',
  // Coastal (army placement)
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
  // Bicoastal
  'stp',
  'spa',
  'bul',
];

const LAND_WITH_SC = new Set([
  'par',
  'mun',
  'vie',
  'bud',
  'mos',
  'war',
  'ser',
  'lon',
  'edi',
  'lvp',
  'bre',
  'mar',
  'ber',
  'kie',
  'rom',
  'nap',
  'ven',
  'tri',
  'sev',
  'con',
  'ank',
  'smy',
  'nor',
  'swe',
  'den',
  'hol',
  'bel',
  'por',
  'tun',
  'rum',
  'gre',
  'stp',
  'spa',
  'bul',
]);

// ---------------------------------------------------------------------------
// Helper: extract all position data for a single-unit snapshot
// ---------------------------------------------------------------------------

interface PositionResult {
  unitCX: number;
  unitCY: number;
  unitType: 'army' | 'fleet';
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  sc: { x: number; y: number } | null;
  textBBox: { x: number; y: number; w: number; h: number } | null;
}

async function getPositionData(
  page: import('@playwright/test').Page,
  province: string,
): Promise<PositionResult> {
  return page.evaluate((prov: string) => {
    // 1. Province group bounding box (union of all direct child paths)
    const group = document.querySelector(`.province-group[data-province="${prov}"]`);
    if (!group) throw new Error(`Province group not found: ${prov}`);

    const paths = group.querySelectorAll(':scope > path');
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const path of paths) {
      const bb = (path as SVGGraphicsElement).getBBox();
      minX = Math.min(minX, bb.x);
      minY = Math.min(minY, bb.y);
      maxX = Math.max(maxX, bb.x + bb.width);
      maxY = Math.max(maxY, bb.y + bb.height);
    }

    // 2. Unit marker — only one unit on the map
    const marker = document.querySelector('.unit-marker');
    if (!marker) throw new Error('No unit marker found');

    let unitCX: number, unitCY: number;
    let unitType: 'army' | 'fleet';
    const circle = marker.querySelector('circle');
    const rect = marker.querySelector('rect');
    if (circle) {
      unitCX = parseFloat(circle.getAttribute('cx')!);
      unitCY = parseFloat(circle.getAttribute('cy')!);
      unitType = 'fleet';
    } else if (rect) {
      unitCX = parseFloat(rect.getAttribute('x')!) + 7;
      unitCY = parseFloat(rect.getAttribute('y')!) + 7;
      unitType = 'army';
    } else {
      throw new Error('Unit marker has no circle or rect child');
    }

    // 3. SC dot — look for g[id="sc"] within province group
    let sc: { x: number; y: number } | null = null;
    const scGroup = group.querySelector(':scope > g[id="sc"]');
    if (scGroup) {
      const scPath = scGroup.querySelector('path');
      if (scPath) {
        const d = scPath.getAttribute('d') || '';
        // d is like "m{X} {Y}c..." — parse first two numbers
        const match = d.match(/^m\s*([\d.-]+)\s+([\d.-]+)/i);
        if (match) {
          sc = { x: parseFloat(match[1]), y: parseFloat(match[2]) - 4 };
        }
      }
    }

    // 4. Text label bounding box
    let textBBox: { x: number; y: number; w: number; h: number } | null = null;
    const textEl = group.querySelector('text[id]') as SVGTextElement | null;
    if (textEl) {
      const tb = textEl.getBBox();
      textBBox = { x: tb.x, y: tb.y, w: tb.width, h: tb.height };
    }

    return {
      unitCX,
      unitCY,
      unitType,
      bbox: { minX, minY, maxX, maxY },
      sc,
      textBBox,
    };
  }, province);
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertInsideBBox(result: PositionResult, label: string, margin = 15) {
  expect(result.unitCX, `${label} cx >= bbox.minX - margin`).toBeGreaterThanOrEqual(
    result.bbox.minX - margin,
  );
  expect(result.unitCX, `${label} cx <= bbox.maxX + margin`).toBeLessThanOrEqual(
    result.bbox.maxX + margin,
  );
  expect(result.unitCY, `${label} cy >= bbox.minY - margin`).toBeGreaterThanOrEqual(
    result.bbox.minY - margin,
  );
  expect(result.unitCY, `${label} cy <= bbox.maxY + margin`).toBeLessThanOrEqual(
    result.bbox.maxY + margin,
  );
}

function assertNoScOverlap(result: PositionResult, label: string) {
  if (!result.sc) return;
  const dx = result.unitCX - result.sc.x;
  const dy = result.unitCY - result.sc.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Army: half-size 7 + SC radius 4 = 11; Fleet: half-size 8 + SC radius 4 = 12
  const minDist = result.unitType === 'army' ? 11 : 12;
  expect(dist, `${label} unit center >=${minDist}px from SC center`).toBeGreaterThanOrEqual(
    minDist,
  );
}

function rectsIntersect(
  ax1: number,
  ay1: number,
  ax2: number,
  ay2: number,
  bx1: number,
  by1: number,
  bx2: number,
  by2: number,
): boolean {
  return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
}

function assertNoTextOverlap(result: PositionResult, label: string) {
  if (!result.textBBox) return;
  const half = result.unitType === 'army' ? 7 : 8;
  const unitX1 = result.unitCX - half;
  const unitY1 = result.unitCY - half;
  const unitX2 = result.unitCX + half;
  const unitY2 = result.unitCY + half;

  const textX1 = result.textBBox.x;
  const textY1 = result.textBBox.y;
  const textX2 = result.textBBox.x + result.textBBox.w;
  const textY2 = result.textBBox.y + result.textBBox.h;

  const overlaps = rectsIntersect(unitX1, unitY1, unitX2, unitY2, textX1, textY1, textX2, textY2);
  expect(overlaps, `${label} unit should not overlap text label`).toBe(false);
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

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
    // Add padding in SVG coords
    const pad = 20;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    // Transform corners to screen coords
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Army placement', () => {
  for (const prov of LAND_PROVINCES) {
    test(prov, async ({ page }) => {
      const unit: TestUnit = { type: 'Army', power: 'England', province: prov };
      server.setSnapshot(makeSnapshot([unit]));
      await page.goto(server.url);
      await page.waitForSelector('.unit-marker', { state: 'attached', timeout: 10_000 });
      await page.waitForTimeout(500);

      const result = await getPositionData(page, prov);

      expect(result.unitType, `${prov} should render as army`).toBe('army');

      // 1. Unit within province bounding box (15px margin)
      assertInsideBBox(result, prov);

      // 2. Unit center >11px from SC dot center (if province has an SC)
      if (LAND_WITH_SC.has(prov)) {
        assertNoScOverlap(result, prov);
      }

      // 3. Unit does NOT overlap the text label
      assertNoTextOverlap(result, prov);

      // 4. Screenshot snapshot
      const screenshot = await screenshotProvince(page, prov);
      expect(screenshot).toMatchSnapshot(`${prov}-army.png`, {
        maxDiffPixels: 12,
      });
    });
  }
});
