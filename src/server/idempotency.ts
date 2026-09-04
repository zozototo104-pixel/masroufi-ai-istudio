/**
 * Persistent idempotency gate for financial mutations.
 *
 * Rules:
 * - Every financial write must have an operationId.
 * - operationId is hashed before being used as Firestore doc id.
 * - A duplicate operation returns the first completed result.
 * - A pending duplicate waits outside the Firestore transaction.
 * - If the lock cannot be claimed, fail closed and do not write money.
 */
import { createHash } from 'crypto';
import { adminDb } from './firebaseAdmin';
import { IDEMPOTENCY_COLLECTION } from './idempotencyConfig';
import {
  IDEMPOTENCY_TTL_MS,
  buildCompletedIdempotencyRecord,
  buildIndeterminateIdempotencyRecord,
  buildPendingIdempotencyRecord,
  decideIdempotencyClaim,
  type ClaimDecision,
} from './idempotencyCore';

function idemDocId(userId: string, operationId: string): string {
  return createHash('sha256').update(`${userId}:${operationId}`).digest('hex');
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCompletedResult(ref: any, attempts = 20): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    await sleep(150);
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    if (data.status === 'completed') return data.result;
    if (data.status === 'failed') return data.result || { success: false, error: 'previous attempt failed' };
  }
  return {
    success: false,
    retryable: true,
    inFlight: true,
    reason: 'IDEMPOTENT_OPERATION_IN_FLIGHT',
    message: 'هذه العملية المالية قيد التنفيذ بالفعل. لم أكرر التسجيل حتى لا يتضاعف القيد.'
  };
}

export interface IdempotencyOutcome {
  kind: 'cache_hit' | 'cache_miss';
  cachedResult?: any;
  result?: any;
}

export async function runIdempotent(
  userId: string,
  operationId: string | undefined,
  fn: () => Promise<any>,
): Promise<IdempotencyOutcome> {
  if (!operationId || typeof operationId !== 'string' || operationId.length < 4) {
    return {
      kind: 'cache_hit',
      cachedResult: {
        success: false,
        retryable: true,
        reason: 'MISSING_OPERATION_ID',
        message: 'رفضت تنفيذ عملية مالية بدون operationId حتى لا تتكرر. أعد المحاولة بعد تحديث التطبيق.'
      }
    };
  }

  const docId = idemDocId(userId, operationId);
  const ref = adminDb.collection(IDEMPOTENCY_COLLECTION).doc(docId);
  const now = Date.now();
  let claim: ClaimDecision;

  try {
    claim = await adminDb.runTransaction(async (tx: any) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as any) : null;
      const decision = decideIdempotencyClaim(data, now);
      if (decision.action !== 'execute') return decision;

      tx.set(ref, buildPendingIdempotencyRecord(userId, operationId, now, data?.createdAt), { merge: false });
      return decision;
    });
  } catch (err: any) {
    console.error('[idempotency] failed to claim financial operation; refusing unsafe write:', err?.message);
    return {
      kind: 'cache_hit',
      cachedResult: {
        success: false,
        retryable: true,
        reason: 'IDEMPOTENCY_LOCK_FAILED',
        message: 'رفضت تسجيل العملية لأن قفل منع التكرار لم يتأكد. أعد المحاولة بعد لحظات حتى لا يتضاعف المبلغ.',
        error: err?.message || 'idempotency lock failed',
      }
    };
  }

  if (claim.action === 'return') return { kind: 'cache_hit', cachedResult: claim.result };
  if (claim.action === 'wait') return { kind: 'cache_hit', cachedResult: await waitForCompletedResult(ref) };

  try {
    const result = await fn();
    const completedAt = Date.now();
    await ref.set(buildCompletedIdempotencyRecord(userId, operationId, result, completedAt), { merge: true });
    return { kind: 'cache_miss', result };
  } catch (err: any) {
    // Once fn() has started, an exception does NOT prove that its financial side
    // effects rolled back. Persist an indeterminate terminal state and fail closed;
    // a retry with the same operationId must never execute fn() again automatically.
    const indeterminate = buildIndeterminateIdempotencyRecord(userId, operationId, err, Date.now());
    try {
      await ref.set(indeterminate, { merge: true });
    } catch (persistErr: any) {
      console.error('[IDEMPOTENCY] Failed to persist indeterminate outcome', {
        operationIdPreview: operationId.slice(0, 80),
        executionError: err?.message,
        persistenceError: persistErr?.message,
      });
    }
    throw err;
  }
}

export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  const snap = await adminDb.collection(IDEMPOTENCY_COLLECTION)
    .where('updatedAt', '<', cutoff)
    .limit(100)
    .get();
  if (snap.size === 0) return 0;
  const batch = adminDb.batch();
  snap.forEach((d: any) => batch.delete(d.ref));
  await batch.commit();
  return snap.size;
}
