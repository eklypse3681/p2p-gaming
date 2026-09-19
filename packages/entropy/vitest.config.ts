import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'entropy', environment: 'node', include: ['test/**/*.test.ts'] },
});
