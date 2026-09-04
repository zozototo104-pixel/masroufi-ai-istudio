/**
 * V6.2 — Durable Offline Pending Operations Queue (OFF-01..OFF-09 + FINDING-03/04/06).
 *
 * CRITICAL V6.2 CHANGE:
 *   The queue now stores FINANCIAL COMMANDS (intent), NOT final database documents.
 *   When replaying, each command is dispatched through /api/command which calls
 *   dispatchFinancialCommand() → routes to the SAME tool handlers used online.
 *   This means offline replay MUST pass through the financial validation engine
 *   (overpayment, insufficient funds, debt guards, idempotency, atomicity).
 *   NO MORE generic doc.set() bypass via /api/sync.
 *
 * Non-financial state (report edits, commitment status updates) still goes through
 * /api/sync. Financial mutations go through /api/command.
 *
 * Client-side IndexedDB queue that survives:
 *   - Browser reload (IndexedDB is durable)
 *   - Cloud Run restart (queue is on client, not server)
 *   - Network outages (retry on reconnect)
 *   - Login A → logout → Login B (B cannot see A's queue — keyed by userId)
 *
 * Each pending op carries:
 *   operationId, userId, commandType, args (tool arguments, NOT final doc),
 *   createdAt, retryCount, lastAttemptAt, syncStatus
 *
 * Sync states: PENDING | SYNCING | COMMITTED | FAILED
 *
 * When Firestore returns, the queue auto-syncs via /api/command. operationId
 * prevents duplication (server-side idempotency layer rejects duplicates).
 */

import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

const QUEUE_KEY = 'masrofi_pending_ops_v6_2';  // V6.2: new key to avoid mixing with V6.1 schema

export type SyncStatus = 'PENDING' | 'SYNCING' | 'COMMITTED' | 'FAILED';

// V6.2: command types must match FinancialCommandType on the server.
export type FinancialCommandType =
  | 'ADD_TRANSACTION'
  | 'TRANSFER_MONEY'
  | 'PAY_DEBT'
  | 'SEND_PALPAY_PAYMENT'
  | 'UPDATE_TRANSACTION'
  | 'DELETE_TRANSACTION';

export interface PendingOperation {
  operationId: string;
  userId: string;
  commandType: FinancialCommandType;  // V6.2: stores COMMAND, not final document
  args: any;                          // V6.2: tool arguments (NOT the final transaction doc)
  createdAt: string;
  retryCount: number;
  lastAttemptAt: string | null;
  syncStatus: SyncStatus;
  failureReason?: string;
}

/** Get all pending ops for a specific user (keyed by userId for isolation). */
export async function getPendingOps(userId: string): Promise<PendingOperation[]> {
  const all = (await idbGet<PendingOperation[]>(QUEUE_KEY)) || [];
  return (all || []).filter(op => op.userId === userId && op.syncStatus !== 'COMMITTED');
}

/** Add a new pending operation. */
export async function enqueuePendingOp(
  userId: string,
  commandType: FinancialCommandType,
  args: any,
  operationId: string,
): Promise<PendingOperation> {
  const all = (await idbGet<PendingOperation[]>(QUEUE_KEY)) || [];
  // Don't add if operationId already exists (idempotent enqueue).
  if (all.some(op => op.operationId === operationId)) {
    return all.find(op => op.operationId === operationId)!;
  }
  const op: PendingOperation = {
    operationId,
    userId,
    commandType,
    args,
    createdAt: new Date().toISOString(),
    retryCount: 0,
    lastAttemptAt: null,
    syncStatus: 'PENDING',
  };
  all.push(op);
  await idbSet(QUEUE_KEY, all);
  return op;
}

/** Mark an op as SYNCING (about to send to server). */
export async function markOpSyncing(operationId: string): Promise<void> {
  const all = (await idbGet<PendingOperation[]>(QUEUE_KEY)) || [];
  const op = all.find(o => o.operationId === operationId);
  if (op) {
    op.syncStatus = 'SYNCING';
    op.lastAttemptAt = new Date().toISOString();
    await idbSet(QUEUE_KEY, all);
  }
}

/** Mark an op as COMMITTED (server confirmed success). Removes from queue. */
export async function markOpCommitted(operationId: string): Promise<void> {
  const all = (await idbGet<PendingOperation[]>(QUEUE_KEY)) || [];
  const filtered = all.filter(op => op.operationId !== operationId);
  await idbSet(QUEUE_KEY, filtered);
}

/** Mark an op as FAILED (server returned error). Keeps in queue for retry. */
export async function markOpFailed(operationId: string, reason: string): Promise<void> {
  const all = (await idbGet<PendingOperation[]>(QUEUE_KEY)) || [];
  const op = all.find(o => o.operationId === operationId);
  if (op) {
    op.syncStatus = 'FAILED';
    op.failureReason = reason;
    op.retryCount = (op.retryCount || 0) + 1;
    op.lastAttemptAt = new Date().toISOString();
    await idbSet(QUEUE_KEY, all);
  }
}

/**
 * Attempt to sync all pending ops for a user. Returns the number successfully synced.
 *
 * V6.2: routes financial commands through /api/command (NOT /api/sync).
 * The server's dispatchFinancialCommand() applies ALL financial validation.
 */
export async function syncPendingOps(
  userId: string,
  idToken: string,
): Promise<{ synced: number; failed: number; remaining: number }> {
  const pending = await getPendingOps(userId);
  let synced = 0, failed = 0;
  for (const op of pending) {
    if (op.syncStatus === 'COMMITTED') continue;
    await markOpSyncing(op.operationId);
    try {
      const result = await sendOpToServer(op, idToken);
      if (result.success) {
        await markOpCommitted(op.operationId);
        synced++;
      } else {
        // V6.2: server rejected (e.g., insufficient funds after canonical state changed).
        // Mark as FAILED — user will be notified.
        await markOpFailed(op.operationId, result.error || 'rejected');
        failed++;
      }
    } catch (err: any) {
      await markOpFailed(op.operationId, err?.message || 'network error');
      failed++;
    }
  }
  const remaining = (await getPendingOps(userId)).length;
  return { synced, failed, remaining };
}

/**
 * V6.2: send financial command through /api/command (NOT /api/sync).
 * The server dispatches to the SAME tool handler used by online AI calls,
 * so ALL financial validation is applied. NO backdoor.
 */
async function sendOpToServer(op: PendingOperation, idToken: string): Promise<{ success: boolean; error?: string }> {
  const headers = { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' };
  const res = await fetch('/api/command', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      command: {
        operationId: op.operationId,
        userId: op.userId,
        commandType: op.commandType,
        args: op.args,
        createdAt: op.createdAt,
      },
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { success: false, error: data.error || `HTTP ${res.status}` };
  }
  const data = await res.json();
  // V6.2: the dispatchFinancialCommand returns the tool handler's result.
  // If success is false (e.g., needsClarification, insufficient funds), surface as failure.
  if (data && data.success === false) {
    return { success: false, error: data.error || data.message || 'tool rejected' };
  }
  return { success: true };
}

/** Clear all pending ops for a user (used on logout / account switch). */
export async function clearPendingOpsForUser(userId: string): Promise<void> {
  const all = (await idbGet<PendingOperation[]>(QUEUE_KEY)) || [];
  const filtered = all.filter(op => op.userId !== userId);
  await idbSet(QUEUE_KEY, filtered);
}

/** Get count of pending ops (for UI badge). */
export async function getPendingCount(userId: string): Promise<number> {
  return (await getPendingOps(userId)).length;
}

/**
 * V6.2 (FINDING-05): one-time migration from legacy V6.1 queue key.
 * Reads the old 'masrofi_pending_ops_v6_1' (or 'masrofi_pending_ops') key,
 * migrates entries to the new schema (storing commandType + args), and clears the old key.
 * Safe to call multiple times — it's idempotent.
 */
export async function migrateLegacyPendingOps(userId: string): Promise<number> {
  const legacyKeys = ['masrofi_pending_ops_v6_1', 'masrofi_pending_ops'];
  let quarantined = 0;

  for (const legacyKey of legacyKeys) {
    const legacy = (await idbGet<any[]>(legacyKey)) || [];
    if (!Array.isArray(legacy) || legacy.length === 0) continue;

    const owned = legacy.filter((op: any) => op?.userId === userId);
    if (owned.length === 0) continue;

    // V6.3 safety rule: legacy rows are persistence documents, not typed financial
    // commands. Their original intent cannot be reconstructed reliably. Converting
    // every row to ADD_TRANSACTION can duplicate transfers, debt payments, updates,
    // or deletes. Quarantine them instead of guessing financial meaning.
    const quarantineKey = `${legacyKey}_quarantine_v6_3`;
    const existingQuarantine = (await idbGet<any[]>(quarantineKey)) || [];
    const existingIds = new Set(existingQuarantine.map((op: any) => String(op?.operationId || op?.id || '')));
    const toQuarantine = owned.filter((op: any) => {
      const id = String(op?.operationId || op?.id || '');
      return !id || !existingIds.has(id);
    });

    if (toQuarantine.length > 0) {
      await idbSet(quarantineKey, [
        ...existingQuarantine,
        ...toQuarantine.map((op: any) => ({
          ...op,
          quarantinedAt: new Date().toISOString(),
          quarantineReason: 'UNSAFE_LEGACY_FINANCIAL_REPLAY_DISABLED',
        })),
      ]);
      quarantined += toQuarantine.length;
    }

    // Remove this user's legacy rows from active replay only after quarantine is durable.
    const remaining = legacy.filter((op: any) => op?.userId !== userId);
    await idbSet(legacyKey, remaining);
  }

  // Kept as a number for API compatibility. No legacy operation is replayed.
  return quarantined;
}

