import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'soak', environment: 'node', include: ['test/**/*.test.ts'], testTimeout: 60_000 },
});
