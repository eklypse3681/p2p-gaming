import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'club', environment: 'node', include: ['test/**/*.test.ts'] },
});
