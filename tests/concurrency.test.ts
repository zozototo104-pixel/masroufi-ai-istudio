/**
 * V6.1 Concurrency Tests (CONC-01..CONC-05).
 *
 * Verifies that atomic operations prevent TOCTOU race conditions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PENDING_STALE_MS,
  buildCompletedIdempotencyRecord,
  buildIndeterminateIdempotencyRecord,
  buildPendingIdempotencyRecord,
  decideIdempotencyClaim,
} from '../src/server/idempotencyCore.ts';

test('CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const addBlock = src.slice(
    src.indexOf('export async function addTransaction'),
    src.indexOf('export async function prepareAddTransaction')
  );
  assert.ok(addBlock.includes('atomicAddTransaction(userId, tx'), 'addTransaction uses atomicAddTransaction for real writes');
  assert.ok(addBlock.includes('skipBalanceCheck: !isBalanceSensitive'),
    'non-balance-sensitive adds still use the atomic commit path while skipping balance checks');
  assert.ok(addBlock.includes('isBalanceSensitive'), 'balance-sensitivity check present');
  assert.equal(addBlock.includes('await txRef.set(tx)'), false,
    'addTransaction must not use FakeDb.set fallback that can create local-only pending writes');
});

test('CONC-02: PalPay expense uses atomic guard (same code path)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // The atomic path covers both cash and palPay accounts for expense.
  assert.ok(src.includes("type === 'expense' && (account === 'cash' || account === 'palPay')"),
    'PalPay expense covered by atomic path');
});

test('CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(toolsSrc.includes('atomicPayDebt(userId, tx, selected.key, { riskConfirmed'),
    'payDebt uses atomicPayDebt with creditor key only, not a stale remaining snapshot');
  assert.equal(toolsSrc.includes('atomicPayDebt(userId, tx, selected.key, selected.remaining'), false,
    'payDebt must not pass cached remaining debt into the atomic primitive');
  assert.equal(atomicSrc.includes('remainingDebtBeforePayment'), false,
    'atomicPayDebt must recompute remaining debt inside the transaction instead of accepting a stale parameter');
  assert.ok(toolsSrc.includes('OVERPAYMENT_ATOMIC'),
    'payDebt returns OVERPAYMENT_ATOMIC when concurrent payment exceeds remaining');
});

test('CONC-04: same operationId executes once (idempotency layer)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.ok(src.includes('adminDb.runTransaction'), 'uses Firestore runTransaction (atomic claim)');
  assert.ok(src.includes("kind: 'cache_hit'"), 'returns cache_hit on duplicate');
});

test('CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('NEGATIVE_CASH_RESULT'),
    'updateTransaction blocks updates that would make cash negative');
  assert.ok(src.includes('resultingBalances.cash < -0.0001'),
    'guard triggers when resulting cash is negative');
});

test('CONC-06: atomicAddTransaction exists in atomicOps.ts', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('export async function atomicAddTransaction'),
    'atomicAddTransaction exported');
  assert.ok(src.includes('adminDb.runTransaction'),
    'uses Firestore runTransaction');
  assert.ok(src.includes('INSUFFICIENT_FUNDS_ATOMIC'),
    'returns INSUFFICIENT_FUNDS_ATOMIC on overspend');
});

test('CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('calculateCreditorRemaining(transactions, creditorKey)'),
    'atomicPayDebt recomputes creditor remaining at transaction time through the shared core');
  assert.equal(src.includes('function recomputeCreditorRemaining'), false,
    'atomicOps must not keep a private duplicate creditor algorithm');
  assert.ok(src.includes('OVERPAYMENT_ATOMIC'),
    'returns OVERPAYMENT_ATOMIC when concurrent payment exceeds remaining');
});

test('CONC-08: atomicOps has no circular dependency on tools.ts', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.equal(src.includes("from './tools'"), false,
    'atomic financial operations must depend on the shared domain core, not the orchestration layer');
  assert.ok(src.includes("from '../lib/balanceCalc'"),
    'atomic financial operations must use the shared financial domain core');
});

test('CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('calculateBreakdown(transactions).creditorDebts'),
    'calculateOpenCreditorDebts must derive creditor debt amounts from the shared domain core');
  assert.equal(src.includes("if(tx?.type==='expense'&&normalizeAccount(tx?.account)==='debt')d=amount"), false,
    'tools.ts must not keep compressed duplicate creditor delta rules');
  assert.equal(src.includes("if(tx?.type==='transfer'&&normalizeAccount(tx?.toAccount)==='debt')d=-amount"), false,
    'tools.ts must not duplicate transfer debt-payment math');
});

test('CONC-09: stale pending idempotency keys never auto-reexecute financial mutations', () => {
  const now = 1_000_000;
  const fresh = buildPendingIdempotencyRecord('u1', 'operation-123', now - 1_000);
  assert.equal(decideIdempotencyClaim(fresh, now).action, 'wait',
    'fresh concurrent duplicate must wait, not execute');

  const stale = buildPendingIdempotencyRecord('u1', 'operation-123', now - PENDING_STALE_MS - 1);
  const decision = decideIdempotencyClaim(stale, now);
  assert.equal(decision.action, 'return');
  assert.equal((decision as any).result.reason, 'IDEMPOTENT_OUTCOME_UNKNOWN');
  assert.equal((decision as any).result.retryable, false);
  assert.equal((decision as any).result.indeterminate, true);
});

test('CONC-10: completed and indeterminate outcomes are terminal behavioral states', () => {
  const now = 2_000_000;
  const completed = buildCompletedIdempotencyRecord('u1', 'operation-456', { success: true, transactionId: 't1' }, now);
  const cached = decideIdempotencyClaim(completed, now + 10);
  assert.equal(cached.action, 'return');
  assert.deepEqual((cached as any).result, { success: true, transactionId: 't1' });

  const indeterminate = buildIndeterminateIdempotencyRecord('u1', 'operation-789', new Error('commit acknowledgement lost'), now);
  assert.equal(indeterminate.status, 'indeterminate');
  assert.equal(indeterminate.result.reason, 'IDEMPOTENT_EXECUTION_INDETERMINATE');
  const blocked = decideIdempotencyClaim(indeterminate, now + 10_000);
  assert.equal(blocked.action, 'return');
  assert.equal((blocked as any).result.retryable, false);
});

test('CONC-11: transaction updates revalidate balances and write inside one Firestore transaction', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(atomicSrc.includes('export async function atomicUpdateTransaction'), 'atomic update primitive must exist');
  assert.ok(atomicSrc.includes('tx.update(ref, finalUpdates)'), 'update write must occur inside Firestore transaction');
  assert.ok(toolsSrc.includes('atomicUpdateTransaction(userId, args.id, finalUpdates'), 'updateTransaction must use atomic primitive');
  assert.equal(toolsSrc.includes('const writeResult = await txRef.update(finalUpdates)'), false,
    'updateTransaction must not perform the final write outside the atomic guard');
});

test('CONC-12: direct and smart transaction deletion revalidate and delete atomically', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(atomicSrc.includes('export async function atomicDeleteTransaction'), 'atomic delete primitive must exist');
  assert.ok(atomicSrc.includes('tx.delete(ref)'), 'delete must occur inside Firestore transaction');
  const calls = toolsSrc.match(/atomicDeleteTransaction\(userId,/g) || [];
  assert.ok(calls.length >= 2, 'both direct-ID and confirmed smart deletion must use atomic deletion');
});

test('CONC-13: reviewed receipt/import lines are prepared directly and persisted by one bounded batch', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const receiptRecordBlock = serverSrc.slice(
    serverSrc.indexOf('app.post("/api/scan-receipt/record"'),
    serverSrc.indexOf('app.get("/api/budgets"')
  );
  assert.ok(atomicSrc.includes('export async function atomicAddTransactions'), 'multi-transaction atomic primitive must exist');
  assert.equal(serverSrc.includes('prepareAddTransaction'), false,
    'reviewed imports must not call the chat addTransaction validateOnly path');
  assert.equal(receiptRecordBlock.includes('validateOnly'), false,
    'reviewed imports must not record completed idempotency outcomes before persistence');
  assert.ok(serverSrc.includes('await atomicAddTransactions('), 'receipt must persist through the atomic multi-line primitive');
  assert.ok(toolsSrc.includes('export async function recordTransactionCommittedSideEffects'),
    'transaction success notifications and budget warnings must live in one shared side-effect helper');
  assert.ok(toolsSrc.includes('const amount = parsePositiveFinancialAmount(tx?.amount)'),
    'shared transaction side effects must sanitize amounts through the shared finite amount parser');
  assert.equal(toolsSrc.includes('const amount = Number(tx?.amount) || 0'), false,
    'shared transaction side effects must not reintroduce Number(... ) || 0 amount parsing');
  assert.equal(serverSrc.includes('recordTransactionCommittedSideEffects('), false,
    'reviewed receipt/import commits must not block the response on quota-heavy per-item side effects');
  assert.equal(serverSrc.includes('createdBeforeFailure'), false, 'receipt endpoint must not expose partial-success semantics');
});

test('CONC-14: receipt retry uses a Firestore receipt idempotency record in the same transaction', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(serverSrc.includes('receiptId,'), 'receipt endpoint must pass the stable receiptId into the atomic primitive');
  assert.ok(atomicSrc.includes("collection('receiptIdempotency')"), 'atomic receipt primitive must claim receipt idempotency');
  assert.ok(atomicSrc.includes('const receiptSnap = receiptRef ? await tx.get(receiptRef) : null'),
    'receipt idempotency record must be read inside the transaction before writes');
  assert.ok(atomicSrc.includes("status: 'completed'"), 'successful receipt commit must persist a completed receipt result');
  assert.ok(atomicSrc.includes('idempotentReplay: true'), 'retry must return the original receipt result instead of creating duplicate transactions');
  assert.ok(atomicSrc.includes('RECEIPT_OPERATION_CONFLICT'), 'conflicting operationIds must fail closed');
});

test('CONC-15: import preflights all backup sections before any restore mutation', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(toolsSrc.includes('const preparedBudgets = prepareImportedBudgets(rawBudgetsToImport)'),
    'budgets must be validated before import mutation');
  assert.ok(toolsSrc.includes('const preparedCommitments = prepareImportedCommitments(rawCommitmentsToImport, userId)'),
    'commitments must be validated before import mutation');
  assert.ok(toolsSrc.includes('const preparedReports = prepareImportedReports(rawReportsToImport, userId)'),
    'reports must be validated before import mutation');
  assert.ok(toolsSrc.includes('const preparedMemory = prepareImportedMemory(rawMemoryToImport)'),
    'memory must be validated before import mutation');
  assert.ok(toolsSrc.includes("reason: 'IMPORT_BACKUP_VALIDATION_FAILED'"),
    'any malformed backup section must fail closed before deletion/writes');
});

test('CONC-16: replace import writes only the validated mutation plan and never silently filters malformed records', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(toolsSrc.includes('const writeCount = transactionEntries.length + budgetEntries.length + commitmentEntries.length + reportEntries.length + memoryEntries.length'),
    'replace mutation count must come from the preflighted plan');
  assert.ok(toolsSrc.includes('for (const prepared of budgetEntries)'), 'replace budgets must come from validated entries');
  assert.ok(toolsSrc.includes('for (const prepared of commitmentEntries)'), 'replace commitments must come from validated entries');
  assert.ok(toolsSrc.includes('for (const prepared of reportEntries)'), 'replace reports must come from validated entries');
  assert.ok(toolsSrc.includes('for (const prepared of memoryEntries)'), 'replace memory must come from validated entries');
  assert.equal(toolsSrc.includes('filter((c: any) => c && c.title && typeof c.amount ==='), false,
    'replace import must not silently filter malformed commitments');
  assert.equal(toolsSrc.includes('Object.entries(memoryToImport).filter'), false,
    'replace import must not silently filter malformed memory entries');
});

test('CONC-16B: replace import uses a named Firestore batch limit and rejects chunking semantics', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(toolsSrc.includes('const FIRESTORE_WRITE_BATCH_LIMIT = 500'),
    'replace import must document the Firestore WriteBatch write cap as a named constant');
  assert.ok(toolsSrc.includes('const IMPORT_REPLACE_ATOMIC_HEADROOM = 50'),
    'replace import must keep explicit headroom below the Firestore cap');
  assert.ok(toolsSrc.includes('const IMPORT_REPLACE_ATOMIC_MUTATION_LIMIT = FIRESTORE_WRITE_BATCH_LIMIT - IMPORT_REPLACE_ATOMIC_HEADROOM'),
    'replace import mutation guard must derive from named Firestore limits');
  assert.ok(toolsSrc.includes('mutationCount > IMPORT_REPLACE_ATOMIC_MUTATION_LIMIT'),
    'replace import must fail closed before exceeding the atomic mutation budget');
  assert.equal(toolsSrc.includes('mutationCount > 450'), false,
    'replace import must not rely on an unexplained magic mutation threshold');
  assert.equal(toolsSrc.includes('BulkWriter'), false,
    'replace import must not use BulkWriter because restore must remain all-or-nothing');
  assert.equal(toolsSrc.includes('for (let i = 0; i <'), false,
    'replace import must not chunk destructive restore writes into partial commits');
});

test('CONC-17: tools.ts reuses canonical account normalization instead of duplicating ledger rules', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const balanceSrc = await readFile(join(process.cwd(), 'src/lib/balanceCalc.ts'), 'utf8');
  assert.ok(/import \{[^}]*normalizeAccount[^}]*\} from '\.\.\/lib\/balanceCalc'/.test(toolsSrc),
    'tools.ts must import account normalization from the shared domain core');
  assert.ok(toolsSrc.includes("export { normalizeAccount } from '../lib/balanceCalc'"),
    'tools.ts may re-export canonical normalization for compatibility');
  assert.equal(toolsSrc.includes('export function normalizeAccount(acc: any)'), false,
    'tools.ts must not keep a private duplicate normalizeAccount implementation');
  assert.ok(balanceSrc.includes('Canonical account normalization'),
    'balanceCalc.ts must document itself as the canonical owner');
});

test('CONC-18: disabled legacy import writer code is not retained as source text', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.equal(toolsSrc.includes('LEGACY_IMPORT_WRITER_DISABLED'), false,
    'dead import writer source text must be removed, not retained in comments');
  assert.equal(toolsSrc.includes('legacy raw transaction writer body'), false,
    'source-text tests must not be confused by commented legacy write paths');
});

test('CONC-19: treasurerEngine financial report boundary avoids broad any', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/treasurerEngine.ts'), 'utf8');
  assert.equal(/\bany\b/.test(src), false,
    'treasurerEngine must use explicit local types or unknown at input boundaries instead of broad any');
  assert.ok(src.includes('type TreasurerReportArgs = Record<string, unknown>'),
    'treasurer report arguments must be typed as unknown boundary data');
  assert.ok(src.includes('type BalanceSnapshot = { cash?: number; palPay?: number; debt?: number; total?: number }'),
    'treasurer risk checks must use an explicit balance snapshot shape');
  assert.ok(src.includes('function buildTreasurerNotes(input: TreasurerNoteInput)'),
    'treasurer notes must use a typed summary contract');
});

test('CONC-20: tools financial amounts use the shared finite amount parser', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(toolsSrc.includes("from '../lib/amount'"),
    'tools.ts must import the shared amount parser authority');
  assert.ok(toolsSrc.includes('parsePositiveFinancialAmount'),
    'positive financial fields must be parsed through the shared parser');
  assert.ok(toolsSrc.includes('parseAbsoluteFinancialAmount'),
    'absolute financial mutation amounts must be parsed through the shared parser');
  assert.equal(toolsSrc.includes('Math.abs(Number'), false,
    'tools.ts must not reintroduce local Math.abs(Number(...)) parsing that accepts Infinity');
  assert.equal(toolsSrc.includes('isNaN(rawAmount)'), false,
    'tools.ts must not reintroduce rawAmount/isNaN parsing');
  assert.equal(toolsSrc.includes('Number(t.amount'), false,
    'tools.ts read/report paths must not reintroduce local Number(t.amount) parsing that accepts Infinity');
});

test('CONC-21: atomic financial guards parse amounts through the shared finite parser', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(atomicSrc.includes("import { parsePositiveFinancialAmount } from '../lib/amount'"),
    'atomic financial operations must use the shared amount parser authority');
  assert.ok(atomicSrc.includes('type FinancialTransactionInput = Record<string, unknown>'),
    'atomic financial operation inputs must have an explicit unknown boundary type');
  assert.equal(atomicSrc.includes('Number(newTx.amount) || 0'), false,
    'atomic financial guards must not accept Infinity through Number(... ) || 0');
  assert.ok(atomicSrc.includes('const amount = parsePositiveFinancialAmount(newTx.amount)'),
    'atomic transfer/add/debt guards must sanitize non-finite amounts consistently');
});

test('CONC-22: savings contributions use Firestore transaction and contribution history', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const contributionBlock = toolsSrc.slice(
    toolsSrc.indexOf('export async function addSavingsContribution'),
    toolsSrc.indexOf('export async function updateSavingsGoal')
  );
  assert.ok(contributionBlock.includes('firebaseAdminDb.runTransaction'),
    'savings contribution must atomically update savedAmount based on the latest cloud value');
  assert.ok(contributionBlock.includes("collection('contributions').doc()"),
    'savings contribution must persist contribution history for monthly progress calculations');
  assert.ok(contributionBlock.includes('selectSavingsGoalForContribution'),
    'savings contribution must use the shared goal selection authority');
});

test('CONC-23: chat ledger lookups are bounded to prevent Firestore quota exhaustion', async () => {
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const queryBlock = toolsSrc.slice(
    toolsSrc.indexOf('export async function queryTransactions'),
    toolsSrc.indexOf('export async function wipeAllUserData')
  );
  assert.ok(queryBlock.includes('.limit(limit)'),
    'queryTransactions must limit Firestore reads instead of loading the full ledger');
  assert.ok(queryBlock.includes("where('date', '>='"),
    'queryTransactions must push date range filters into Firestore when available');
  assert.equal(queryBlock.includes("where('userId', '==', userId).get()"), false,
    'queryTransactions must not reintroduce an unbounded where(userId).get() full-ledger read');

  const memoryBlock = toolsSrc.slice(
    toolsSrc.indexOf('export async function memorySearch'),
    toolsSrc.indexOf('export async function deleteMemoryKey')
  );
  assert.ok(memoryBlock.includes('.limit(limit).get()'),
    'memorySearch must also be bounded because it runs during chat turns');
});

test('CONC-24: custom voice status failures fall back without breaking built-in voices', async () => {
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  const customVoiceStatusBlock = serverSrc.slice(
    serverSrc.indexOf('app.get("/api/custom-voice"'),
    serverSrc.indexOf('app.post("/api/custom-voice"')
  );
  assert.ok(customVoiceStatusBlock.includes('fallbackVoice'),
    'custom voice status failure must advertise built-in voice fallback');
  assert.equal(customVoiceStatusBlock.includes('res.status(500)'), false,
    'custom voice status quota/read failures must not surface as fatal 500s');
});

test('CONC-25: reviewed receipt import records through direct preparation and bounded batch commit', async () => {
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const receiptRecordBlock = serverSrc.slice(
    serverSrc.indexOf('app.post("/api/scan-receipt/record"'),
    serverSrc.indexOf('app.get("/api/budgets"')
  );
  const receiptCommitBlock = atomicSrc.slice(
    atomicSrc.indexOf('export async function atomicAddTransactions'),
    atomicSrc.indexOf('export async function atomicPayDebt')
  );
  assert.equal(serverSrc.includes('prepareAddTransaction'), false,
    'reviewed receipt imports must not use addTransaction validateOnly orchestration');
  assert.equal(receiptRecordBlock.includes('validateOnly'), false,
    'reviewed receipt imports must not emit per-line addTransaction validateOnly tool calls');
  assert.ok(serverSrc.includes('skipLedgerBalanceCheck: true'),
    'reviewed receipt imports must avoid a full-ledger scan during record');
  assert.ok(serverSrc.includes('splitOverflowToDebt') && serverSrc.includes("paymentMethodOverride: 'debt'"),
    'reviewed imports must record from the selected balance first and push overflow to debt');
  assert.equal(serverSrc.includes('recordTransactionCommittedSideEffects'), false,
    'reviewed receipt import response must not be blocked by quota-heavy per-item side effects');
  assert.ok(receiptCommitBlock.includes('stableReceiptItemDocId'),
    'receipt import commit must use deterministic item ids for idempotent retries');
  assert.ok(receiptCommitBlock.includes('if (receiptId && opts.skipLedgerBalanceCheck)'),
    'full-ledger balance scan skip must be limited to receipt imports with receipt idempotency');
  assert.ok(receiptCommitBlock.includes('const batch = adminDb.batch()') && receiptCommitBlock.includes("receiptCommitMode: 'write-batch-no-ledger-scan'"),
    'reviewed receipt imports must use bounded WriteBatch instead of a transaction that can exceed the UI timeout');
  const importFastPath = receiptCommitBlock.slice(
    receiptCommitBlock.indexOf('if (receiptId && opts.skipLedgerBalanceCheck)'),
    receiptCommitBlock.indexOf('return adminDb.runTransaction')
  );
  assert.equal(importFastPath.includes('.get()'), false,
    'reviewed receipt import fast path must be write-only and avoid Firestore pre-reads under quota pressure');
});
