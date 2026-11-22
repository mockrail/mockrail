import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Tests run against package sources, so `pnpm test` works without a build step.
export default defineConfig({
  resolve: {
    alias: {
      '@mockrail/core': pkg('core'),
      '@mockrail/adapter-bachs': pkg('adapter-bachs'),
      '@mockrail/server': pkg('server'),
      '@mockrail/testing': pkg('testing'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
