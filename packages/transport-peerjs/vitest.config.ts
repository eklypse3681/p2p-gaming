import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'transport-peerjs', environment: 'node', include: ['test/**/*.test.ts'] },
});
