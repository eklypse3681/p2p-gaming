import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'ofc-engine', environment: 'node', include: ['test/**/*.test.ts'] },
});
