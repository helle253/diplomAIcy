import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../..');

export default defineConfig({
  test: {
    include: ['.claude/skills/integration-test/**/*.test.ts'],
    root: projectRoot,
  },
});
