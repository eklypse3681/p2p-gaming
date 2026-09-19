import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'table', environment: 'node', include: ['test/**/*.test.ts'] },
});
