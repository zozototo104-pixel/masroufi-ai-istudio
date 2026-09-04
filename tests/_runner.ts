/**
 * V6 Regression Test Runner
 *
 * Runs all test files in /tests/regression/ and reports results.
 * Tests are run in-process against the in-memory admin stub.
 *
 * Usage:
 *   node --import tsx --test tests/run_tests.ts
 *   # or
 *   npm test
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Allow importing .ts files directly.
// (Already enabled by tsx — we just need to ensure tsx is loaded.)

const tests: { name: string; fn: () => Promise<void> | void }[] = [];

export function test(name: string, fn: () => Promise<void> | void) {
  tests.push({ name, fn });
}

export async function runAll() {
  const results: { name: string; ok: boolean; err?: string }[] = [];
  for (const t of tests) {
    try {
      await t.fn();
      results.push({ name: t.name, ok: true });
    } catch (e: any) {
      results.push({ name: t.name, ok: false, err: e?.stack || e?.message || String(e) });
    }
  }
  return results;
}
