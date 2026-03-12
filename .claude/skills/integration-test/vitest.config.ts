import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

const projectRoot = resolve(__dirname, '../../..');

export default defineConfig({
  test: {
    include: ['.claude/skills/integration-test/**/*.test.ts'],
    root: projectRoot,
  },
});
