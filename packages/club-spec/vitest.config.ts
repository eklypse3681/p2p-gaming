import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'club-spec', environment: 'node', include: ['test/**/*.test.ts'] },
});
