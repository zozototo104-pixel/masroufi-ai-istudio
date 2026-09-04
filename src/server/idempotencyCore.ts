export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_STALE_MS = 2 * 60 * 1000;

export type StoredIdempotencyRecord = {
  status?: 'pending' | 'completed' | 'failed' | 'indeterminate';
  result?: any;
  createdAt?: number;
  updatedAt?: number;
};

export type ClaimDecision =
  | { action: 'execute' }
  | { action: 'return'; result: any }
  | { action: 'wait' };

export function decideIdempotencyClaim(
  data: StoredIdempotencyRecord | null,
  now: number,
): ClaimDecision {
  if (data?.status === 'completed') {
    return { action: 'return', result: data.result };
  }

  if (data?.status === 'pending') {
    const age = now - Number(data.updatedAt || data.createdAt || 0);
    if (age < PENDING_STALE_MS) return { action: 'wait' };

    return {
      action: 'return',
      result: {
        success: false,
        retryable: false,
        indeterminate: true,
        reason: 'IDEMPOTENT_OUTCOME_UNKNOWN',
        message: 'تعذر تأكيد نتيجة العملية السابقة بأمان. لن أعيد تنفيذها تلقائياً حتى لا يتكرر القيد المالي.',
      },
    };
  }

  if (data?.status === 'failed' || data?.status === 'indeterminate') {
    return {
      action: 'return',
      result: data.result || {
        success: false,
        retryable: false,
        indeterminate: true,
        reason: 'IDEMPOTENT_OUTCOME_UNKNOWN',
        message: 'نتيجة العملية السابقة غير محسومة، لذلك لن أعيد تنفيذها تلقائياً.',
      },
    };
  }

  return { action: 'execute' };
}

export function buildPendingIdempotencyRecord(
  userId: string,
  operationId: string,
  now: number,
  existingCreatedAt?: number,
) {
  return {
    userId,
    operationId,
    operationIdPreview: operationId.slice(0, 300),
    status: 'pending' as const,
    createdAt: existingCreatedAt || now,
    updatedAt: now,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  };
}

function stripUndefinedForFirestore(value: any): any {
  if (Array.isArray(value)) {
    return value.filter(item => item !== undefined).map(stripUndefinedForFirestore);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, stripUndefinedForFirestore(item)])
    );
  }
  return value;
}

export function buildCompletedIdempotencyRecord(
  userId: string,
  operationId: string,
  result: any,
  now: number,
) {
  return {
    userId,
    operationId,
    operationIdPreview: operationId.slice(0, 300),
    status: 'completed' as const,
    // Optional response metadata may legitimately be absent. Firestore rejects
    // undefined values, so persist only fields that actually have a value while
    // keeping required financial/idempotency fields protected.
    result: stripUndefinedForFirestore(result),
    completedAt: now,
    updatedAt: now,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  };
}

export function buildIndeterminateIdempotencyRecord(
  userId: string,
  operationId: string,
  executionError: unknown,
  now: number,
) {
  const err: any = executionError;
  const result = {
    success: false,
    retryable: false,
    indeterminate: true,
    reason: 'IDEMPOTENT_EXECUTION_INDETERMINATE',
    error: err?.message || 'execution outcome unknown',
    message: 'تعذر تأكيد نتيجة العملية المالية بأمان، لذلك لن تتم إعادة تنفيذها تلقائياً.',
  };
  return {
    userId,
    operationId,
    operationIdPreview: operationId.slice(0, 300),
    status: 'indeterminate' as const,
    result,
    updatedAt: now,
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  };
}
