import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'gitstore-proto',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
  },
});
