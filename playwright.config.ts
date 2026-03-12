import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 900 },
    // Disable CSS animations/transitions so screenshots capture final state
    contextOptions: {
      reducedMotion: 'reduce',
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
