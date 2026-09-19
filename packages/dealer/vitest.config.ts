import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'dealer', environment: 'node', include: ['test/**/*.test.ts'] },
});
