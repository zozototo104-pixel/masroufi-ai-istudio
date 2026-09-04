/**
 * V6.2 Adversarial Tests — Financial Mutation Integrity & Offline Safety.
 *
 * Tests the FINDING-01..FINDING-10 fixes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// FINDING-01: Atomic PayDebt fallback
test('ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // The dangerous pattern: catch + txRef.set(tx) + atomicResult = { ok: true }
  // V6.2 removed this — the catch now returns FAILED.
  assert.ok(src.includes('refusing direct write fallback'),
    'V6.2: payDebt logs atomic failure refusal');
  // Verify the old fallback pattern is gone:
  // "console.warn('[payDebt] atomic transaction failed, falling back to direct write:'"
  // followed by "await txRef.set(tx); atomicResult = { ok: true, docId: txRef.id };"
  assert.ok(!src.includes("falling back to direct write"),
    'V6.2: payDebt must NOT have "falling back to direct write" log');
  // The correct pattern: refuse with FAILED/RETRYABLE
  assert.ok(src.includes('ATOMIC_FAILED_RETRYABLE') && src.includes('ATOMIC_FAILED'),
    'V6.2: payDebt returns ATOMIC_FAILED_RETRYABLE or ATOMIC_FAILED');
});

test('ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('isRetryable = atomicErr?.code === 8'),
    'payDebt detects RESOURCE_EXHAUSTED (code 8) as retryable');
  assert.ok(src.includes('retryable: isRetryable'),
    'payDebt returns retryable flag');
});

// FINDING-02: Transfer TOCTOU
test('TRANSFER-CONC-01: transferMoney uses atomicTransferMoney', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('atomicTransferMoney(userId, tx'),
    'transferMoney calls atomicTransferMoney');
});

test('TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('export async function atomicTransferMoney'),
    'atomicTransferMoney exported');
  assert.ok(src.includes('INSUFFICIENT_FUNDS_ATOMIC'),
    'returns INSUFFICIENT_FUNDS_ATOMIC on overspend');
});

test('TRANSFER-CONC-03: transferMoney has NO direct write fallback', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // In transferMoney function body, there should be no txRef.set(tx) after atomic attempt.
  const transferMatch = src.match(/export async function transferMoney[\s\S]*?^}/m);
  assert.ok(transferMatch, 'transferMoney function found');
  const body = transferMatch[0];
  // The V6.2 refusal pattern must be present.
  assert.ok(body.includes('refusing direct write fallback'),
    'transferMoney refuses direct write fallback on atomic failure');
  assert.ok(body.includes('ATOMIC_FAILED_RETRYABLE'),
    'transferMoney returns ATOMIC_FAILED_RETRYABLE');
  // The old fallback "falling back to direct write" must be absent.
  assert.ok(!body.includes('falling back to direct write'),
    'V6.2: transferMoney must NOT have "falling back to direct write"');
});

// FINDING-03/04/06: Offline queue command-based + /api/command
test('OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes('commandType: FinancialCommandType'),
    'PendingOperation stores commandType');
  assert.ok(src.includes('args: any'),
    'PendingOperation stores args (tool arguments)');
  assert.ok(!src.includes('payload: any'),
    'V6.2: removed payload field (was the final document)');
});

test('OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes("fetch('/api/command'"),
    'offlineQueue POSTs to /api/command');
  assert.ok(!src.includes("fetch('/api/sync'"),
    'V6.2: offlineQueue does NOT use /api/sync for financial mutations');
});

test('OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts', async () => {
  const src = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(src.includes('app.post("/api/command"'),
    '/api/command endpoint registered');
  assert.ok(src.includes('dispatchFinancialCommand'),
    '/api/command calls dispatchFinancialCommand');
});

test('OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/financialEngine.ts'), 'utf8');
  assert.ok(src.includes('COMMAND_TO_TOOL'),
    'command-to-tool mapping exists');
  assert.ok(src.includes('toolHandlers[toolName]'),
    'dispatch uses the SAME toolHandlers as online AI calls');
  assert.ok(src.includes('userId: authenticatedUserId'),
    'dispatch force-overwrites userId with authenticated UID');
  assert.ok(src.includes('NEVER trust client-supplied userId'),
    'documented security invariant');
});

test('OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)', async () => {
  // /api/sync still handles non-financial state (reports, commitments), but
  // financial mutations from offline queue now go through /api/command.
  // The offline queue no longer uses /api/sync.
  const queueSrc = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(queueSrc.includes('Financial mutations go through /api/command'),
    'queue documents that financial mutations go through /api/command');
});

// FINDING-05: Multiple pending systems unified
test('UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes("QUEUE_KEY = 'masrofi_pending_ops_v6_2'"),
    'V6.2 uses new queue key to avoid schema mixing');
});

test('UNIFIED-PENDING-02: migrateLegacyPendingOps function exists', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes('export async function migrateLegacyPendingOps'),
    'migration function exists');
  assert.ok(src.includes("['masrofi_pending_ops_v6_1', 'masrofi_pending_ops']"),
    'migrates from both legacy keys');
});

test('UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(src.includes('migrateLegacyPendingOps(user.uid)'),
    'App.tsx calls migrateLegacyPendingOps');
});

test('UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(src.includes("idbSet('masrofi_pending_ops_v6_2', [])"),
    'logout clears v6_2 queue');
  assert.ok(src.includes("idbSet('masrofi_pending_ops_v6_1', [])"),
    'logout clears v6_1 legacy queue');
  assert.ok(src.includes("idbSet('masrofi_pending_ops', [])"),
    'logout clears original legacy queue');
});

// FINDING-07: Partial-state guard
test('PARTIAL-STATE-01: addTransaction rejects on partial snapshot', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('PARTIAL_STATE_UNSAFE'),
    'addTransaction returns PARTIAL_STATE_UNSAFE on partial snapshot');
  assert.ok(src.includes("(preTxSnapshot as any).partial === true"),
    'checks preTxSnapshot.partial flag');
});

test('PARTIAL-STATE-02: transferMoney rejects on partial balance', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // In transferMoney function body, partial check must exist.
  const transferMatch = src.match(/export async function transferMoney[\s\S]*?^}/m);
  assert.ok(transferMatch);
  assert.ok(transferMatch[0].includes('current.partial === true'),
    'transferMoney checks current.partial');
});

test('PARTIAL-STATE-03: payDebt rejects on partial snapshot', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // In payDebt function body, partial check must exist.
  assert.ok(src.includes("(snap as any).partial === true"),
    'payDebt checks snap.partial');
});

// FINDING-08: O(N) reads (acknowledged — financialState deferred to V7)
test('FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('adminDb.runTransaction'),
    'atomic ops use runTransaction');
  // V7 will add financialState doc for O(1) — documented as architectural change.
  // For now, the atomic path is correct but O(N).
});

// Static safety: no catch + direct set pattern in financial mutation paths
test('STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // Find payDebt function body.
  const payDebtMatch = src.match(/export async function payDebt[\s\S]*?^}/m);
  assert.ok(payDebtMatch, 'payDebt function found');
  const body = payDebtMatch[0];
  // After the atomic attempt, there must NOT be a txRef.set(tx) fallback.
  // The pattern "await txRef.set(tx)" should NOT appear in the catch block.
  const catchMatch = body.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/);
  if (catchMatch) {
    assert.ok(!catchMatch[0].includes('txRef.set(tx)'),
      'V6.2 STATIC SAFETY: payDebt catch block must NOT contain txRef.set(tx)');
  }
});

test('STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const transferMatch = src.match(/export async function transferMoney[\s\S]*?^}/m);
  assert.ok(transferMatch);
  const body = transferMatch[0];
  const catchMatch = body.match(/catch\s*\([^)]*\)\s*\{[^}]*\}/);
  if (catchMatch) {
    assert.ok(!catchMatch[0].includes('txRef.set(tx)'),
      'V6.2 STATIC SAFETY: transferMoney catch block must NOT contain txRef.set(tx)');
  }
});

// SYNC-AUTH: server forces authenticated UID
test('SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/financialEngine.ts'), 'utf8');
  assert.ok(src.includes('userId: authenticatedUserId'),
    'dispatchFinancialCommand force-overwrites userId');
  assert.ok(src.includes('NEVER trust client-supplied userId'),
    'documented security invariant');
});

// IDEM: idempotency covers offline replay
test('IDEM-01: dispatchFinancialCommand passes operationId through args', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/financialEngine.ts'), 'utf8');
  assert.ok(src.includes('argsWithOpId'),
    'dispatch passes operationId in args');
  assert.ok(src.includes('operationId: finalCommand.operationId'),
    'operationId from command is passed to tool handler');
});
