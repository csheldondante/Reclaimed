// Round 115 (tilecal): unit tests without a browser (vitest, node). Only *.test.ts under src/.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
