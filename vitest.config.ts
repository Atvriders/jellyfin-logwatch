import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // CI and the runtime image are UTC; the dev sandbox is not. Pin the suite's
    // timezone so a passing test here means a passing test there.
    env: { TZ: 'UTC' },
  },
});
