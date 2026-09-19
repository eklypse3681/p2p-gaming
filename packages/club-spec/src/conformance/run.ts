/**
 * Headless runner. No test framework involved, so an implementation written in another language
 * can be driven through a thin adapter and still be held to the same standard.
 */

import { CLUB_CONFORMANCE_CHECKS } from './checks.js';
import type {
  Check,
  CheckResult,
  ConformanceOptions,
  ConformanceReport,
  ConformanceTarget,
} from './types.js';
import { SkipCheck } from './types.js';

export { CLUB_CONFORMANCE_CHECKS };

async function runOne(check: Check, opts: ConformanceOptions): Promise<CheckResult> {
  const started = Date.now();
  let target: ConformanceTarget | undefined;
  try {
    target = await opts.create();
    await check.run(target);
    return {
      group: check.group,
      name: check.name,
      status: 'pass',
      durationMs: Date.now() - started,
    };
  } catch (e) {
    const skipped = e instanceof SkipCheck || (e as Error)?.name === 'SkipCheck';
    return {
      group: check.group,
      name: check.name,
      status: skipped ? 'skip' : 'fail',
      note: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - started,
    };
  } finally {
    if (target) await target.close().catch(() => undefined);
  }
}

export async function runClubConformanceChecks(
  opts: ConformanceOptions,
  filter?: (check: Check) => boolean,
): Promise<ConformanceReport> {
  const checks = filter ? CLUB_CONFORMANCE_CHECKS.filter(filter) : CLUB_CONFORMANCE_CHECKS;
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await runOne(check, opts));
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  return { name: opts.name, results, passed, failed, skipped, ok: failed === 0 };
}

/** A compact report, for a CLI or a CI log. */
export function formatConformanceReport(report: ConformanceReport): string {
  const lines: string[] = [`club conformance · ${report.name}`];
  let group = '';
  for (const r of report.results) {
    if (r.group !== group) {
      group = r.group;
      lines.push(`  ${group}`);
    }
    const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '·' : '✗';
    lines.push(`    ${mark} ${r.name}${r.status === 'pass' ? '' : ` — ${r.note ?? ''}`}`);
  }
  lines.push(
    `  ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped — ${
      report.ok ? 'conformant' : 'NOT conformant'
    }`,
  );
  return lines.join('\n');
}
