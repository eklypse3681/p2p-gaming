/**
 * Vitest binding: one `it` per check, so a failure names the rule that was broken.
 *
 * Use from any implementation's own test file:
 *
 *   describe('MyClub', () => runClubConformance({ name: 'MyClub', create }));
 */

import { describe, it } from 'vitest';
import { CLUB_CONFORMANCE_CHECKS } from './checks.js';
import type { Check, ConformanceOptions, ConformanceTarget } from './types.js';
import { SkipCheck } from './types.js';

function bind(check: Check, opts: ConformanceOptions): void {
  it(check.name, async (ctx) => {
    let target: ConformanceTarget | undefined;
    try {
      target = await opts.create();
      await check.run(target);
    } catch (e) {
      if (e instanceof SkipCheck || (e as Error)?.name === 'SkipCheck') {
        ctx.skip((e as Error).message);
        return;
      }
      throw e;
    } finally {
      if (target) await target.close().catch(() => undefined);
    }
  });
}

/** Declare the whole suite against one implementation. Call inside a `describe`. */
export function runClubConformance(opts: ConformanceOptions): void {
  const groups = new Map<string, Check[]>();
  for (const check of CLUB_CONFORMANCE_CHECKS) {
    const list = groups.get(check.group) ?? [];
    list.push(check);
    groups.set(check.group, list);
  }
  for (const [group, checks] of groups) {
    describe(group, () => {
      for (const check of checks) bind(check, opts);
    });
  }
}
