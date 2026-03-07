/**
 * Utility script: computes province bounding-box centers from the SVG using Playwright's browser.
 * Run: npx playwright test tests/e2e/compute-centers.ts
 */
import { test } from '@playwright/test';

import { makeSnapshot, startTestServer, type TestServer } from './test-server.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer([makeSnapshot([])]);
});
test.afterAll(async () => {
  await server.close();
});

test('compute province centers', async ({ page }) => {
  await page.goto(server.url);
  await page.waitForSelector('#units-layer', { state: 'attached', timeout: 10_000 });

  const data = await page.evaluate(() => {
    const svg = document.querySelector('svg')!;
    const groups = svg.querySelectorAll('.province-group');
    const results: Record<
      string,
      { textX: number; textY: number; centerX: number; centerY: number; dx: number; dy: number }
    > = {};

    for (const g of groups) {
      const prov = g.getAttribute('data-province')!;
      const textEl = g.querySelector(':scope > text[id]') as SVGTextElement;
      if (!textEl) continue;

      // Get text position (same logic as main.ts getTextPosition)
      const style = textEl.getAttribute('style') || '';
      const matrixMatch = style.match(
        /matrix\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([^,]+),\s*([^)]+)\)/,
      );
      let textX = 0,
        textY = 0;
      if (matrixMatch) {
        textX = parseFloat(matrixMatch[1]);
        textY = parseFloat(matrixMatch[2]);
      } else {
        textX = parseFloat(textEl.getAttribute('x') || '0');
        textY = parseFloat(textEl.getAttribute('y') || '0');
      }

      // Get the path bounding box (not text, not SC circle)
      const paths = g.querySelectorAll(':scope > path');
      if (paths.length === 0) continue;

      // Compute combined bounding box of all paths
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const path of paths) {
        const bbox = (path as SVGGraphicsElement).getBBox();
        minX = Math.min(minX, bbox.x);
        minY = Math.min(minY, bbox.y);
        maxX = Math.max(maxX, bbox.x + bbox.width);
        maxY = Math.max(maxY, bbox.y + bbox.height);
      }

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      // Token default position is (textX, textY - 15)
      // Offset needed: center - default
      const dx = Math.round(centerX - textX);
      const dy = Math.round(centerY - (textY - 15));

      results[prov] = {
        textX,
        textY,
        centerX: Math.round(centerX),
        centerY: Math.round(centerY),
        dx,
        dy,
      };
    }
    return results;
  });

  // Print as a JS object for UNIT_OFFSETS
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  console.log('\n=== PROVINCE CENTERS (SVG coords) ===');
  for (const [prov, d] of entries) {
    console.log(
      `${prov}: text=(${d.textX},${d.textY}) center=(${d.centerX},${d.centerY}) offset={dx:${d.dx}, dy:${d.dy}}`,
    );
  }

  console.log('\n=== UNIT_OFFSETS ===');
  console.log('const UNIT_OFFSETS: Record<string, { dx: number; dy: number }> = {');
  for (const [prov, d] of entries) {
    if (d.dx !== 0 || d.dy !== 0) {
      console.log(`  ${prov}: { dx: ${d.dx}, dy: ${d.dy} },`);
    }
  }
  console.log('};');
});
