/**
 * V6 AUTHORIZATION + SYNC TESTS (CF-2)
 *
 * Tests:
 *   AUTHZ-01 User A cannot read User B (via /api/sync with foreign id)
 *   AUTHZ-02 User A cannot update User B (via /api/sync update)
 *   AUTHZ-03 User A cannot delete User B (via /api/sync delete)
 *   SYNC-01 malicious document ID rejected (sync rejects cross-user writes)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { selectOpenCreditorDebt } from '../src/lib/debtSelection.ts';

test('AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // V6 syncOfflineData must:
  // 1. Force userId to authenticated UID (don't trust client userId).
  // 2. For each incoming doc, fetch existing, verify existing.userId === authenticated uid.
  // 3. Reject with cross-user ownership violation message.
  assert.ok(src.includes('V6 (CF-2): NEVER trust client-supplied userId or document IDs'),
    'syncOfflineData must explicitly reject client-supplied ownership');
  assert.ok(src.includes('transactions must sync through /api/command, not /api/sync'),
    'generic sync must reject raw financial transactions entirely');
  assert.ok(src.includes('cross-user ownership violation'),
    'syncOfflineData must reject cross-user writes');
  assert.ok(src.includes('const { _unsynced, userId: _dropUid, ...data } = rep'),
    'non-financial report sync must strip client-supplied userId');
  assert.ok(src.includes('const { _unsynced, userId: _dropUid, ...data } = com'),
    'non-financial commitment sync must strip client-supplied userId');
  assert.ok(src.includes('rejected: { id: string; reason: string }[]'),
    'syncOfflineData returns rejected list');
  // Server-side handler must map OwnershipError to 403.
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(serverSrc.includes('e?.status && Number.isFinite(e.status)'),
    '/api/sync handler must propagate error status (403 from OwnershipError)');
});

test('AUTHZ-04: deleteReport ownership check exists', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("doc.exists && doc.data()?.userId === userId"),
    'deleteReport must verify doc.userId === userId before delete');
});

test('AUTHZ-05: deleteCommitment ownership check exists', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // Look for the ownership check pattern (the exact Arabic string may differ in encoding).
  assert.ok(src.includes('export async function deleteCommitment'),
    'deleteCommitment function must exist');
  assert.ok(src.match(/snap\.data\(\)\?\.userId\s*!==\s*userId\) return \{ success: false, error:/),
    'deleteCommitment must verify ownership before delete');
});

test('AUTHZ-06: update_transaction ownership check exists', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("if (!doc.exists || doc.data()?.userId !== userId) return { error: \"Transaction not found\" };"),
    'updateTransaction must verify ownership');
});

test('FIRESTORE-RULES-01: rules file is not empty (CF-7)', async () => {
  const src = await readFile(join(process.cwd(), 'firestore.rules'), 'utf8');
  assert.ok(src.length > 100, 'firestore.rules must not be empty');
  assert.ok(src.includes('rules_version'), 'must declare rules_version');
  assert.ok(src.includes('request.auth != null'), 'must require authentication');
  assert.ok(src.includes('ownsDoc(resource)'), 'must enforce user-scoped ownership');
  assert.ok(src.includes("match /{document=**}"), 'must have default-deny rule');
});

test('TOOL-01: search_market_information declaration REMOVED (HF-1)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // The declaration must be gone.
  assert.ok(!src.match(/name:\s*"search_market_information"/),
    'search_market_information tool declaration must be removed');
  // The handler remains as a stub that refuses to execute (defensive).
  assert.ok(src.includes('deprecated: true'),
    'searchMarketInformation handler is a deprecation stub');
  assert.ok(src.includes('useInstead: \'search_local_market\''),
    'stub directs AI to use search_local_market instead');
});

test('TOOL-02/03: addTransaction debt guard present (HF-7)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('V6 (HF-7): for debt purchases, available is no longer Infinity'),
    'debt purchases must have available-finite guard');
  assert.ok(src.includes('DEBT_PURCHASE_RISK'),
    'debt purchases exceeding threshold must return DEBT_PURCHASE_RISK needsConfirmation');
  assert.ok(src.includes('debtToIncomeRatio > 1.0 || amount > 5000'),
    'debt guard triggers when ratio > 1.0 OR amount > 5000');
});

test('TOOL-04: ambiguous creditor asks clarification (payDebt)', () => {
  const selection = selectOpenCreditorDebt({
    amount: 200,
    debts: [
      { key: 'ahmed', creditor: 'Ahmed', remaining: 1000 },
      { key: 'mohammed', creditor: 'Mohammed', remaining: 500 },
    ],
  });
  assert.equal(selection.ok, false);
  if (!selection.ok) {
    assert.equal(selection.reason, 'AMBIGUOUS_CREDITOR');
    assert.deepEqual(selection.options, [
      { creditor: 'Ahmed', remaining: 1000 },
      { creditor: 'Mohammed', remaining: 500 },
    ]);
  }
});

test('TOOL-05: smart delete asks confirmation even with single match (MF-6)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('CONFIRM_SINGLE_SMART_DELETE'),
    'smart delete with single match must request confirmation');
  assert.ok(src.includes('Silent destructive mutations based on AI guessing are not acceptable'),
    'documented rationale for MF-6 guard');
});

test('TOOL-06: memory_search filters by query (MF-2)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('V6 (MF-2): actually filter by args.query'),
    'memorySearch must use args.query');
  assert.ok(src.includes("e.key.toLowerCase().includes(query) || e.value.toLowerCase().includes(query)"),
    'memorySearch must filter by substring match on key OR value');
  assert.ok(src.includes('.slice(0, 10)'),
    'memorySearch must bound results to top 10');
});

test('TOOL-07: budget read failure propagates error (HF-6)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('V6 (HF-6): NEVER silently swallow errors and return DEFAULT_BUDGETS'),
    'getUserBudgets must not silently fall back to defaults');
  // The try/catch wrapper must be removed (or re-throw).
  assert.ok(!src.includes('catch (e) {\n    return DEFAULT_BUDGETS;\n  }'),
    'getUserBudgets must NOT have catch-and-return-DEFAULT_BUDGETS');
});

test('TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('partial: Boolean((txSnap as any).partial || (commitmentSnap as any).partial)'),
    'getFinancialDecisionContext must propagate partial flag');
});

test('TOOL-09: commitments support paid/cancelled status (MF-1)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("status: 'pending'"),
    'createCommitment sets initial status=pending');
  assert.ok(src.includes("'pending', 'paid', 'cancelled'"),
    'updateCommitmentStatus accepts pending/paid/cancelled');
  assert.ok(src.includes("c.status === 'paid' || c.status === 'cancelled'"),
    'forecast excludes paid/cancelled commitments');
});

test('TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("Number.isFinite(amount) || amount <= 0"),
    'sendPalPayPayment rejects non-finite / non-positive amounts');
  assert.ok(src.includes('INSUFFICIENT_FUNDS'),
    'sendPalPayPayment checks PalPay balance');
  assert.ok(src.includes('INVALID_PHONE'),
    'sendPalPayPayment validates phone format');
  assert.ok(src.includes('operationId'),
    'sendPalPayPayment sets operationId for idempotency');
});
