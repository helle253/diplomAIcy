import type { Page } from '@playwright/test';

import {
  makeOrdersSnapshot,
  makeSnapshot,
  STARTING_SC,
  type TestServer,
  type TestUnit,
} from './test-server.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArrowInfo {
  tag: string;
  stroke: string;
  strokeDasharray: string | null;
  markerEnd: string | null;
  opacity: string | null;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Navigate to the test server and wait for the SVG map to be ready.
 * Replaces the old `page.goto` + `waitForTimeout(1500)` pattern.
 */
export async function gotoAndWaitForMap(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForSelector('#map-container svg', { state: 'attached', timeout: 10_000 });
}

/**
 * Set up a two-snapshot scenario (pre-orders + Orders) and move the slider
 * to the Orders phase, waiting for the arrows layer to be populated.
 * Replaces the old `setupArrowScenario` + `waitForTimeout(500)` pattern.
 */
export async function setupArrowScenario(
  page: Page,
  server: TestServer,
  beforeUnits: TestUnit[],
  afterUnits: TestUnit[],
  orders: Parameters<typeof makeOrdersSnapshot>[1],
  expectedArrowCount?: number,
): Promise<void> {
  const preOrdersSnap = makeSnapshot(beforeUnits, STARTING_SC, {
    year: 1901,
    season: 'Spring',
    type: 'Orders',
  });
  const ordersSnap = makeOrdersSnapshot(afterUnits, orders, STARTING_SC, {
    year: 1901,
    season: 'Spring',
    type: 'Orders',
  });
  server.setSnapshots([preOrdersSnap, ordersSnap]);
  await page.evaluate(() => {
    const slider = document.querySelector('#phase-slider') as HTMLInputElement;
    slider.value = '1';
    slider.dispatchEvent(new Event('input'));
  });

  // Wait for arrows to render instead of sleeping
  if (expectedArrowCount !== undefined && expectedArrowCount > 0) {
    await page.waitForFunction(
      (count) => {
        const layer = document.querySelector('#arrows-layer');
        return layer !== null && layer.children.length >= count;
      },
      expectedArrowCount,
      { timeout: 5_000 },
    );
  } else {
    // For cases where we don't know the count, wait for the layer to exist
    await page.waitForSelector('#arrows-layer', { state: 'attached', timeout: 5_000 });
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getArrows(page: Page): Promise<ArrowInfo[]> {
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

export async function getArrowCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const layer = document.querySelector('#arrows-layer');
    return layer ? layer.children.length : 0;
  });
}

export async function getSupportArrows(page: Page): Promise<ArrowInfo[]> {
  const all = await getArrows(page);
  return all.filter((a) => a.strokeDasharray !== null);
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

/**
 * Compute a clip rectangle spanning the given provinces.
 * Returns clip coordinates for use with `toHaveScreenshot({ clip })`.
 */
export async function getRegionClip(
  page: Page,
  provinces: string[],
): Promise<{ x: number; y: number; width: number; height: number }> {
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
  return clip;
}
