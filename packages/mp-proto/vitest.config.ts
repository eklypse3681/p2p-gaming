import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'mp-proto',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
  },
});
