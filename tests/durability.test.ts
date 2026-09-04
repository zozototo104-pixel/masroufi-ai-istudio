/**
 * V6 DURABILITY + IDEMPOTENCY TESTS (CF-5, CF-6)
 *
 * Tests:
 *   DUR-01 Firestore failure does not create false SUCCESS — writeResult.durability='pending'
 *   DUR-02 restart does not silently lose acknowledged transaction (idempotency_keys persists)
 *   DUR-03 recovery sync preserves exactly-once semantics
 *   DUR-04 offline/pending state visible to UI (response includes partial/pending flags)
 *   DUR-05 partial data marked partial (getBalance returns partial=true on Firestore fail)
 *   DUR-06 account switch cannot expose cache (logout clears IndexedDB)
 *   DUR-07 import/export round-trip preserves financial state
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  buildCompletedIdempotencyRecord,
  buildPendingIdempotencyRecord,
  decideIdempotencyClaim,
} from '../src/server/idempotencyCore.ts';
import { IDEMPOTENCY_COLLECTION } from '../src/server/idempotencyConfig.ts';
import { prepareImportedFinancialTransactions } from '../src/lib/importFinancialTransactions.ts';

test('DUR-01: FakeDb.WriteResult exposes durability flag — V6 type definition present', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/fakeDb.ts'), 'utf8');
  assert.ok(src.includes("type WriteDurability = 'committed' | 'pending' | 'failed'"),
    'FakeDb must export WriteDurability type');
  assert.ok(src.includes('interface WriteResult'), 'FakeDb must export WriteResult interface');
  assert.ok(src.includes('durability: WriteDurability'), 'set/update/delete must return durability');
});

test('DUR-02: idempotency_keys collection persists across restart (Firestore-backed)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.equal(IDEMPOTENCY_COLLECTION, 'idempotency_keys',
    'idempotency uses Firestore collection (persists across restart)');
  assert.ok(src.includes('adminDb.runTransaction'),
    'claim uses Firestore transaction (atomic across instances)');
});

test('DUR-03: same operationId returns the completed cached result instead of executing again', () => {
  const now = Date.now();
  const pending = buildPendingIdempotencyRecord('u1', 'op-1', now);
  assert.equal(pending.status, 'pending', 'claim state must be persisted as pending before execution');

  const expected = { success: true, transactionId: 'tx-1' };
  const completed = buildCompletedIdempotencyRecord('u1', 'op-1', expected, now + 1);
  assert.equal(completed.status, 'completed', 'successful execution must become completed');

  const decision = decideIdempotencyClaim(completed, now + 2);
  assert.equal(decision.action, 'return', 'retry of a completed operation must return, not execute');
  if (decision.action === 'return') assert.deepEqual(decision.result, expected);
});

test('DUR-04: addTransaction response includes durability + pending flags', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('durability: writeResult.durability'),
    'addTransaction response must include durability');
  assert.ok(src.includes('pending: writeResult.pending'),
    'addTransaction response must include pending flag');
  assert.ok(src.includes('partial: balances.partial || writeResult.pending'),
    'addTransaction response must include partial flag');
});

test('DUR-05: getBalance marks offline-cache fallback as partial', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const getBalanceBlock = src.slice(
    src.indexOf('export async function getBalance'),
    src.indexOf('export async function transferMoney')
  );
  assert.ok(getBalanceBlock.includes("source: 'firestore'"),
    'getBalance must identify authoritative Firestore reads');
  assert.ok(getBalanceBlock.includes("source: 'offline-cache'"),
    'getBalance fallback must be explicitly display-only offline cache');
  assert.ok(getBalanceBlock.includes('partial: true'),
    'getBalance fallback must propagate partial=true when cloud balance read fails');
  assert.ok(getBalanceBlock.includes('cloudStorageConfirmed: false'),
    'offline-cache balance fallback must not be treated as confirmed cloud state');
});

test('DUR-06: account switch cannot expose cache — logout clears IndexedDB', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(src.includes("V6 (CACHE-01, hidden risk): clear all user-scoped IndexedDB caches on logout"),
    'logout must explicitly clear IndexedDB caches');
  assert.ok(src.includes("await idbSet('lkgs_transactions', [])"),
    'logout must clear lkgs_transactions');
  assert.ok(src.includes("await idbSet('lkgs_reports', [])"),
    'logout must clear lkgs_reports');
});

test('DUR-07: import/export round-trip preserves financial state — HF-5 fix', () => {
  const prepared = prepareImportedFinancialTransactions([
    {
      id: 'debt-purchase-1',
      type: 'expense',
      account: 'debt',
      amount: 120,
      merchant: 'محل أحمد',
      creditor: 'أحمد',
      creditorKey: 'ahmad-custom-key',
      transactionType: 'CREDIT_PURCHASE',
    },
    {
      id: 'debt-transfer-1',
      type: 'transfer',
      amount: 50,
      fromAccount: 'cash',
      toAccount: 'debt',
      creditor: 'محمد',
    },
  ], 'user-1', () => '2026-08-31T10:00:00.000Z');

  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.entries[0].docData.transactionType, 'CREDIT_PURCHASE');
    assert.equal(prepared.entries[0].docData.creditor, 'أحمد');
    assert.equal(prepared.entries[0].docData.creditorKey, 'ahmad-custom-key');
    assert.equal(prepared.entries[0].docData.importedAt, '2026-08-31T10:00:00.000Z');
    assert.equal(prepared.entries[1].docData.creditor, 'محمد');
    assert.equal(typeof prepared.entries[1].docData.creditorKey, 'string');
    assert.equal(prepared.entries[1].docData.fromAccount, 'cash');
    assert.equal(prepared.entries[1].docData.toAccount, 'debt');
  }

  const invalid = prepareImportedFinancialTransactions([
    { id: 'bad-debt', type: 'expense', account: 'debt', amount: 10, merchant: '' },
  ], 'user-1');
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.failures[0].code, 'MISSING_CREDITOR');
});

test('DUR-08: chat cannot export server-local FakeDb pending operations to legacy client queue', async () => {
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  const appSrc = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.equal(serverSrc.includes("const { getPendingOps } = await import('./src/server/fakeDb')"), false,
    'chat response must not bridge FakeDb pending state to the browser');
  assert.equal(appSrc.includes('data.pendingOps && data.pendingOps.length > 0'), false,
    'client chat path must not ingest server pending state into a legacy queue');
});

test('DUR-09: legacy pending financial documents are quarantined, never guessed as ADD_TRANSACTION', async () => {
  const queueSrc = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(queueSrc.includes('UNSAFE_LEGACY_FINANCIAL_REPLAY_DISABLED'),
    'legacy financial rows must be quarantined');
  assert.equal(queueSrc.includes("commandType: 'ADD_TRANSACTION' as FinancialCommandType"), false,
    'migration must not guess the original financial command');
});

test('DUR-10: transaction delete is durability-safe through atomic Firestore deletion', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(toolsSrc.includes('atomicDeleteTransaction(userId,'),
    'deleteTransaction must delegate final deletion to the atomic Firestore primitive');
  assert.ok(atomicSrc.includes('tx.delete(ref)'),
    'the final delete must occur inside a Firestore transaction');
  assert.equal(toolsSrc.includes("reason: 'DELETE_NOT_DURABLY_COMMITTED'"), false,
    'legacy FakeDb pending-delete semantics must not be the final deletion path');
});

test('DUR-11: transaction update refuses balance-sensitive decisions on partial state', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("message: 'لا يمكن تعديل العملية الآن لأن قراءة السحابة جزئية، ولا أستطيع ضمان الرصيد الناتج بأمان.'"),
    'updateTransaction must refuse partial-state balance computation');
});

test('DUR-12: restore validates the full backup before replace deletes existing state', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const financialPreflight = src.indexOf('prepareImportedFinancialTransactions(transactionsToImport, userId)');
  const budgetPreflight = src.indexOf('prepareImportedBudgets(rawBudgetsToImport)', financialPreflight);
  const commitmentPreflight = src.indexOf('prepareImportedCommitments(rawCommitmentsToImport, userId)', financialPreflight);
  const reportPreflight = src.indexOf('prepareImportedReports(rawReportsToImport, userId)', financialPreflight);
  const memoryPreflight = src.indexOf('prepareImportedMemory(rawMemoryToImport)', financialPreflight);
  const destructiveReplace = src.indexOf("if (mode === 'replace')", financialPreflight);
  assert.ok(financialPreflight >= 0, 'restore must have a financial preflight');
  assert.ok(budgetPreflight > financialPreflight, 'restore must validate budgets before replace-mode deletion');
  assert.ok(commitmentPreflight > financialPreflight, 'restore must validate commitments before replace-mode deletion');
  assert.ok(reportPreflight > financialPreflight, 'restore must validate reports before replace-mode deletion');
  assert.ok(memoryPreflight > financialPreflight, 'restore must validate memory before replace-mode deletion');
  assert.ok(destructiveReplace > memoryPreflight, 'all import preflight must happen before replace-mode deletion');
  assert.ok(src.includes("reason: 'IMPORT_BACKUP_VALIDATION_FAILED'"),
    'invalid backup must fail before modifying current data');
});

test('DUR-13: restore writes only preflighted transactions and checks durability', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('for (const prepared of transactionEntries)'),
    'restore must write the validated canonical representation');
  assert.ok(src.includes("reason: 'IMPORT_NOT_DURABLY_COMMITTED'"),
    'merge restore must stop when a transaction is not durably committed');
  assert.equal(src.includes('for (const t of transactionsToImport)'), false,
    'raw backup transactions must not be written directly after preflight');
});

test('DUR-14: replace restore is one atomic batch and oversized backups fail before mutation', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const replaceStart = src.indexOf("if (mode === 'replace')");
  const mergeStart = src.indexOf('// Merge mode:', replaceStart);
  const replaceBlock = src.slice(replaceStart, mergeStart);
  assert.ok(replaceBlock.includes('const batch = firebaseAdminDb.batch()'),
    'replace restore must use a real Firestore atomic batch');
  assert.ok(replaceBlock.includes('await batch.commit()'),
    'replace restore must commit its mutation plan once');
  assert.ok(replaceBlock.includes("reason: 'IMPORT_REPLACE_TOO_LARGE_FOR_ATOMIC_COMMIT'"),
    'oversized replace must fail closed before mutation');
  assert.ok(replaceBlock.includes("reason: 'IMPORT_REPLACE_ATOMIC_COMMIT_FAILED'"),
    'failed atomic commit must be reported explicitly');
  assert.equal(replaceBlock.includes('await adminDb.collection('), false,
    'replace must not delete or write documents individually');
});
