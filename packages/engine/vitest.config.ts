import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'engine', environment: 'node', include: ['test/**/*.test.ts'] },
});
