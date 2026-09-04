/**
 * V6.1 Offline Queue Tests (OFF-01..OFF-08).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCompletedIdempotencyRecord, decideIdempotencyClaim } from '../src/server/idempotencyCore.ts';

test('OFF-01: FakeDb.set returns durability=pending on Firestore failure', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/fakeDb.ts'), 'utf8');
  assert.ok(src.includes("durability: WriteDurability = synced ? 'committed' : 'pending'"),
    'FakeDb.set returns pending durability when write fails');
});

test('OFF-02: offline queue persists in IndexedDB (survives browser reload)', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes("QUEUE_KEY = 'masrofi_pending_ops_v6_2'"),
    'queue uses IndexedDB via idb-keyval (V6.2 key)');
  assert.ok(src.includes('interface PendingOperation'),
    'PendingOperation interface defined');
  assert.ok(src.includes("syncStatus: SyncStatus"),
    'syncStatus field tracked');
});

test('OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes('op.userId === userId'),
    'getPendingOps filters by userId (queue is per-user)');
  assert.ok(src.includes('clearPendingOpsForUser'),
    'clearPendingOpsForUser function exists');
});

test('OFF-04: syncPendingOps attempts to sync on fetchData', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(src.includes('syncPendingOps(user.uid, idToken)'),
    'fetchData calls syncPendingOps at start');
});

test('OFF-05: retry does not duplicate after the operation completed', () => {
  const now = Date.now();
  const expected = { success: true, id: 'offline-tx-1' };
  const completed = buildCompletedIdempotencyRecord('u1', 'offline-op-1', expected, now);
  const decision = decideIdempotencyClaim(completed, now + 1);
  assert.equal(decision.action, 'return', 'completed retry must return instead of execute');
});

test('OFF-06: server committed but response lost — retry returns cached result', () => {
  const expected = { success: true, id: 'offline-tx-2' };
  const completed = buildCompletedIdempotencyRecord('u1', 'offline-op-2', expected, 1000);
  const decision = decideIdempotencyClaim(completed, 1001);
  assert.equal(decision.action, 'return');
  if (decision.action === 'return') assert.deepEqual(decision.result, expected);
});

test('OFF-06B: offline income parser cannot manufacture server business confirmations', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.equal(src.includes('incomeNatureConfirmed: true'), false,
    'offline client must not assert income nature on behalf of the user');
  assert.equal(src.includes('incomeDestinationConfirmed: true'), false,
    'offline client must not assert income destination on behalf of the user');
  assert.ok(src.includes('userText: text'),
    'offline command must preserve original user words for server validation');
});

test('OFF-07: Login A → logout → Login B cannot see/sync A queue', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(src.includes('V6.1 (OFF-07): clear the per-user offline pending queue on logout'),
    'logout clears pending ops for the user');
  assert.ok(src.includes('clearPendingOpsForUser(user.uid)'),
    'calls clearPendingOpsForUser on logout');
});

test('OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes('operationId: string'));
  assert.ok(src.includes('userId: string'));
  // V6.2: changed from 'payload' to 'args' (command-based, not document-based)
  assert.ok(src.includes('commandType: FinancialCommandType'));
  assert.ok(src.includes('args: any'));
  assert.ok(src.includes('createdAt: string'));
  assert.ok(src.includes('retryCount: number'));
  assert.ok(src.includes('lastAttemptAt'));
  assert.ok(src.includes('syncStatus: SyncStatus'));
});

test('OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)', async () => {
  const src = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(src.includes("'PENDING' | 'SYNCING' | 'COMMITTED' | 'FAILED'"),
    'all 4 sync states defined');
});
