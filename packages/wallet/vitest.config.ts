import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'wallet', environment: 'node', include: ['test/**/*.test.ts'] },
});
