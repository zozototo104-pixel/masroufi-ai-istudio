/**
 * V6.1 — Atomic Financial Mutations (CONC-01..CONC-05).
 *
 * Wraps balance-sensitive operations (cash expense, PalPay expense, transfers,
 * debt payment, PalPay payment) in Firestore runTransaction to prevent TOCTOU
 * race conditions.
 *
 * Race scenario prevented:
 *   Cash=1000, Request A expense=800, Request B expense=800
 *   Without atomicity: both succeed, Cash=-600 (overspent).
 *   With atomicity: A claims the funds first, B sees insufficient and fails.
 *
 * Implementation: each mutation is added as a NEW transaction document inside
 * a Firestore runTransaction that reads the user's current transaction set,
 * recomputes balances, and rejects if the operation would violate invariants.
 *
 * Note: this is the application-level use of runTransaction (NOT the idempotency
 * layer's transaction which protects against duplicate operationId).
 */
import { createHash } from 'crypto';
import { adminDb } from './firebaseAdmin';
import { parsePositiveFinancialAmount } from '../lib/amount';
import { calculateBalances, calculateCreditorRemaining } from '../lib/balanceCalc';

type FinancialTransactionInput = Record<string, unknown> & {
  id?: unknown;
  userId?: unknown;
  amount?: unknown;
  type?: unknown;
  account?: unknown;
  fromAccount?: unknown;
  toAccount?: unknown;
  operationId?: unknown;
  receiptId?: unknown;
};

type BalanceSnapshot = { cash: number; palPay: number; debt: number; total: number };

type FirestoreDocLike = {
  id?: string;
  data?: () => Record<string, unknown>;
};

function plainTransactions(docs: FirestoreDocLike[]): FinancialTransactionInput[] {
  return (docs || []).map((doc) => typeof doc?.data === 'function' ? { id: doc.id, ...doc.data() } : doc as FinancialTransactionInput);
}

function stableReceiptDocId(userId: string, receiptId: string): string {
  return createHash('sha256').update(`${userId}:receipt:${receiptId}`).digest('hex');
}

function stableReceiptItemDocId(userId: string, operationId: string): string {
  return createHash('sha256').update(`${userId}:receipt-item:${operationId}`).digest('hex');
}

function sameReceiptTransaction(existing: FinancialTransactionInput, incoming: FinancialTransactionInput): boolean {
  const existingAmount = parsePositiveFinancialAmount(existing?.amount);
  const incomingAmount = parsePositiveFinancialAmount(incoming?.amount);
  const existingReceiptId = String(existing?.receiptId || '');
  const incomingReceiptId = String(incoming?.receiptId || '');
  const operationId = String(existing?.operationId || '');
  const receiptCompatible = existingReceiptId === incomingReceiptId
    || (!existingReceiptId && incomingReceiptId && operationId.startsWith(`receipt:${incomingReceiptId}:`));
  return operationId === String(incoming?.operationId || '')
    && Math.abs(existingAmount - incomingAmount) < 0.01
    && String(existing?.type || '') === String(incoming?.type || '')
    && String(existing?.account || '') === String(incoming?.account || '')
    && receiptCompatible;
}

/**
 * V6.2 (FINDING-02): Atomic balance-sensitive transfer.
 *
 * Prevents TOCTOU where two concurrent transfers from the same source wallet
 * both pass the preflight check (insufficient funds guard) but together
 * would drive the wallet below zero.
 *
 * Implementation: runTransaction reads the user's ledger, recomputes balances,
 * rejects if source wallet has insufficient funds, then writes inside the
 * same transaction.
 */
export async function atomicTransferMoney(
  userId: string,
  newTx: FinancialTransactionInput,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; docId: string } | { ok: false; reason: string; available?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    const snap = await tx.get(
      adminDb.collection('transactions').where('userId', '==', userId)
    );
    const balances = calculateBalances(plainTransactions(snap.docs));
    const amount = parsePositiveFinancialAmount(newTx.amount);
    const fromAccount = String(newTx.fromAccount || 'cash');
    // Debt source (borrowing) doesn't need balance check (creates new debt).
    if (fromAccount !== 'debt') {
      const available = fromAccount === 'palPay' ? balances.palPay : balances.cash;
      if (amount > available + 0.0001 && !opts.riskConfirmed) {
        return {
          ok: false,
          reason: 'INSUFFICIENT_FUNDS_ATOMIC',
          available: Math.round(available * 100) / 100,
        };
      }
    }
    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    return { ok: true, docId: newRef.id };
  });
}

/**
 * Atomic guard for a balance-sensitive financial mutation.
 *
 * Flow:
 *   1. Open Firestore runTransaction.
 *   2. Read user's transaction collection atomically.
 *   3. Compute resulting balances (as if the new tx were added).
 *   4. If the resulting cash or palPay would go negative AND the operation
 *      is balance-sensitive (NOT debt): REJECT.
 *   5. If approved: write the new tx document inside the same transaction.
 *
 * @param userId - authenticated UID
 * @param newTx - the transaction document to write (without id)
 * @param opts  - guard options
 * @returns { ok: true, docId } on success, { ok: false, reason } on rejection
 */
export async function atomicAddTransaction(
  userId: string,
  newTx: FinancialTransactionInput,
  opts: {
    /** Skip the cash/palPay negative-balance check (e.g., for debt purchases). */
    skipBalanceCheck?: boolean;
    /** Allow the operation even if it would result in negative balance (riskConfirmed). */
    riskConfirmed?: boolean;
  } = {}
): Promise<{ ok: true; docId: string } | { ok: false; reason: string; available?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    // Read user's transactions collection (atomic w.r.t. this transaction).
    const snap = await tx.get(
      adminDb.collection('transactions').where('userId', '==', userId)
    );
    const existingDocs = snap.docs;
    const balances = calculateBalances(plainTransactions(existingDocs));

    // Determine the new account impact.
    const account = String(newTx.account || (newTx.fromAccount === 'cash' || newTx.fromAccount === 'palPay' ? newTx.fromAccount : 'cash'));
    const amount = parsePositiveFinancialAmount(newTx.amount);
    const type = String(newTx.type || '');

    if (!opts.skipBalanceCheck && !opts.riskConfirmed) {
      // For cash/palPay expenses and outbound transfers, check available funds.
      let affectedAccount: 'cash' | 'palPay' | null = null;
      if (type === 'expense' && (account === 'cash' || account === 'palPay')) {
        affectedAccount = account;
      } else if (type === 'transfer' && newTx.fromAccount && newTx.fromAccount !== 'debt') {
        affectedAccount = newTx.fromAccount === 'palPay' ? 'palPay' : 'cash';
      }
      if (affectedAccount) {
        const available = affectedAccount === 'cash' ? balances.cash : balances.palPay;
        if (amount > available + 0.0001) {
          return {
            ok: false,
            reason: 'INSUFFICIENT_FUNDS_ATOMIC',
            available: Math.round(available * 100) / 100,
          };
        }
      }
    }

    // Approved — write inside the transaction.
    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    return { ok: true, docId: newRef.id };
  });
}

/**
 * Atomic guard for debt payment (CONC-03).
 *
 * Prevents concurrent payments from exceeding the creditor's remaining debt.
 * Reads all transactions, computes per-creditor remaining debt, then rejects
 * if the payment would exceed it.
 */
export async function atomicUpdateTransaction(
  userId: string,
  transactionId: string,
  finalUpdates: any,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number } } | { ok: false; reason: string; balances?: any }> {
  return adminDb.runTransaction(async (tx: any) => {
    const ref = adminDb.collection('transactions').doc(transactionId);
    const targetSnap = await tx.get(ref);
    if (!targetSnap.exists || targetSnap.data()?.userId !== userId) {
      return { ok: false, reason: 'TRANSACTION_NOT_FOUND' };
    }

    const ledgerSnap = await tx.get(adminDb.collection('transactions').where('userId', '==', userId));
    const projected = { ...targetSnap.data(), ...finalUpdates, userId };
    const transactions = ledgerSnap.docs.map((doc: any) => doc.id === transactionId ? projected : doc.data());
    const balances = calculateBalances(transactions);

    if (!opts.riskConfirmed && balances.cash < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_CASH_RESULT', balances };
    }
    if (!opts.riskConfirmed && balances.palPay < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_PALPAY_RESULT', balances };
    }

    tx.update(ref, finalUpdates);
    return { ok: true, balances };
  });
}

export async function atomicDeleteTransaction(
  userId: string,
  transactionId: string,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number } } | { ok: false; reason: string; balances?: any }> {
  return adminDb.runTransaction(async (tx: any) => {
    const ref = adminDb.collection('transactions').doc(transactionId);
    const targetSnap = await tx.get(ref);
    if (!targetSnap.exists || targetSnap.data()?.userId !== userId) {
      return { ok: false, reason: 'TRANSACTION_NOT_FOUND' };
    }

    const ledgerSnap = await tx.get(adminDb.collection('transactions').where('userId', '==', userId));
    const remaining = ledgerSnap.docs.filter((doc: any) => doc.id !== transactionId).map((doc: any) => doc.data());
    const balances = calculateBalances(remaining);

    if (!opts.riskConfirmed && balances.cash < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_CASH_RESULT', balances };
    }
    if (!opts.riskConfirmed && balances.palPay < -0.0001) {
      return { ok: false, reason: 'NEGATIVE_PALPAY_RESULT', balances };
    }

    tx.delete(ref);
    return { ok: true, deleted: targetSnap.data(), balances };
  });
}

export async function atomicAddTransactions(
  userId: string,
  newTransactions: any[],
  opts: { riskConfirmed?: boolean; receiptId?: string; receiptMeta?: any; skipLedgerBalanceCheck?: boolean } = {}
): Promise<
  | { ok: true; docIds: string[]; balances: { cash: number; palPay: number; debt: number; total: number }; idempotentReplay?: boolean }
  | { ok: false; reason: string; balances?: any; conflictingTransactionIds?: string[] }
> {
  const receiptId = opts.receiptId ? String(opts.receiptId) : '';

  if (receiptId && opts.skipLedgerBalanceCheck) {
    const normalizedNewTransactions = newTransactions.map((item: any) => ({ ...item, receiptId }));
    const operationIds = normalizedNewTransactions.map((item: any) => String(item?.operationId || ''));
    if (operationIds.some((operationId: string) => !operationId)) {
      return { ok: false, reason: 'MISSING_RECEIPT_OPERATION_ID' };
    }
    if (new Set(operationIds).size !== operationIds.length) {
      return { ok: false, reason: 'DUPLICATE_RECEIPT_OPERATION_ID' };
    }

    const batch = adminDb.batch();
    const docIds: string[] = [];
    normalizedNewTransactions.forEach((item: any) => {
      const ref = adminDb.collection('transactions').doc(stableReceiptItemDocId(userId, String(item.operationId)));
      docIds.push(ref.id);
      batch.set(ref, { ...item, userId, id: ref.id, balanceValidation: 'receipt-import-bounded-batch', receiptCommitMode: 'write-batch-no-ledger-scan' });
    });
    const balances = calculateBalances(normalizedNewTransactions.map((item: any) => ({ ...item, userId })));
    await batch.commit();
    return { ok: true, docIds, balances };
  }

  return adminDb.runTransaction(async (tx: any) => {
    const receiptId = opts.receiptId ? String(opts.receiptId) : '';
    const receiptRef = receiptId
      ? adminDb.collection('receiptIdempotency').doc(stableReceiptDocId(userId, receiptId))
      : null;
    const receiptSnap = receiptRef ? await tx.get(receiptRef) : null;
    if (receiptSnap?.exists) {
      const record = receiptSnap.data() || {};
      if (record.userId !== userId || record.receiptId !== receiptId) {
        return { ok: false, reason: 'RECEIPT_ID_CONFLICT' };
      }
      if (record.status === 'completed' && Array.isArray(record.docIds)) {
        return {
          ok: true,
          docIds: record.docIds,
          balances: record.balances || { cash: 0, palPay: 0, debt: 0, total: 0 },
          idempotentReplay: true,
        };
      }
      return { ok: false, reason: 'RECEIPT_OUTCOME_INDETERMINATE' };
    }

    const normalizedNewTransactions = newTransactions.map((item: any) => receiptId ? { ...item, receiptId } : item);
    if (receiptId) {
      const operationIds = normalizedNewTransactions.map((item: any) => String(item?.operationId || ''));
      if (operationIds.some((operationId: string) => !operationId)) {
        return { ok: false, reason: 'MISSING_RECEIPT_OPERATION_ID' };
      }
      if (new Set(operationIds).size !== operationIds.length) {
        return { ok: false, reason: 'DUPLICATE_RECEIPT_OPERATION_ID' };
      }
    }

    if (receiptId && opts.skipLedgerBalanceCheck) {
      const itemRefs = normalizedNewTransactions.map((item: any) =>
        adminDb.collection('transactions').doc(stableReceiptItemDocId(userId, String(item.operationId)))
      );
      const itemSnaps = await Promise.all(itemRefs.map((ref: any) => tx.get(ref)));
      const existingMatches = itemSnaps
        .map((snap: any, index: number) => ({ snap, index, item: normalizedNewTransactions[index] }))
        .filter((row: any) => row.snap.exists);

      if (existingMatches.length > 0) {
        const allRowsAlreadyCommitted = existingMatches.length === normalizedNewTransactions.length
          && existingMatches.every((row: any) => sameReceiptTransaction(row.snap.data() || {}, row.item));
        if (allRowsAlreadyCommitted) {
          const docIds = itemRefs.map((ref: any) => ref.id);
          const balances = calculateBalances(itemSnaps.map((snap: any) => snap.data()).filter(Boolean));
          if (receiptRef) {
            tx.set(receiptRef, {
              userId,
              receiptId,
              status: 'completed',
              docIds,
              operationIds: normalizedNewTransactions.map((item: any) => item.operationId),
              itemCount: normalizedNewTransactions.length,
              balances,
              balanceScope: 'receipt-items-only',
              receiptMeta: opts.receiptMeta || null,
              recoveredFromStableReceiptItems: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return { ok: true, docIds, balances, idempotentReplay: true };
        }
        return {
          ok: false,
          reason: 'RECEIPT_OPERATION_CONFLICT',
          conflictingTransactionIds: existingMatches.map((row: any) => row.snap.id).filter(Boolean),
        };
      }

      const balances = calculateBalances(normalizedNewTransactions.map((item: any) => ({ ...item, userId })));
      const docIds: string[] = [];
      normalizedNewTransactions.forEach((item: any, index: number) => {
        const ref = itemRefs[index];
        docIds.push(ref.id);
        tx.set(ref, { ...item, userId, id: ref.id, balanceValidation: 'skipped-full-ledger-for-receipt-import' });
      });
      if (receiptRef) {
        tx.set(receiptRef, {
          userId,
          receiptId,
          status: 'completed',
          docIds,
          operationIds: normalizedNewTransactions.map((item: any) => item.operationId),
          itemCount: normalizedNewTransactions.length,
          balances,
          balanceScope: 'receipt-items-only',
          receiptMeta: opts.receiptMeta || null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
      return { ok: true, docIds, balances };
    }

    const snap = await tx.get(adminDb.collection('transactions').where('userId', '==', userId));
    const existing = plainTransactions(snap.docs);

    if (receiptId) {
      const existingByOperationId = new Map<string, any>();
      for (const item of existing) {
        const operationId = String(item?.operationId || '');
        if (operationId) existingByOperationId.set(operationId, item);
      }
      const overlapping = normalizedNewTransactions
        .map((item: any) => existingByOperationId.get(String(item?.operationId || '')))
        .filter(Boolean);
      if (overlapping.length > 0) {
        const allRowsAlreadyCommitted = overlapping.length === normalizedNewTransactions.length
          && normalizedNewTransactions.every((item: any) => {
            const existingItem = existingByOperationId.get(String(item?.operationId || ''));
            return existingItem && sameReceiptTransaction(existingItem, item);
          });
        if (allRowsAlreadyCommitted) {
          const balances = calculateBalances(existing);
          const docIds = normalizedNewTransactions.map((item: any) => existingByOperationId.get(String(item?.operationId || ''))?.id).filter(Boolean);
          if (receiptRef) {
            tx.set(receiptRef, {
              userId,
              receiptId,
              status: 'completed',
              docIds,
              operationIds: normalizedNewTransactions.map((item: any) => item.operationId),
              itemCount: normalizedNewTransactions.length,
              balances,
              receiptMeta: opts.receiptMeta || null,
              recoveredFromExistingTransactions: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }
          return { ok: true, docIds, balances, idempotentReplay: true };
        }
        return {
          ok: false,
          reason: 'RECEIPT_OPERATION_CONFLICT',
          conflictingTransactionIds: overlapping.map((item: any) => item.id).filter(Boolean),
        };
      }
    }

    const projected = [...existing, ...normalizedNewTransactions.map((item: any) => ({ ...item, userId }))];
    const balances = calculateBalances(projected);

    if (!opts.riskConfirmed && balances.cash < -0.0001) return { ok: false, reason: 'NEGATIVE_CASH_RESULT', balances };
    if (!opts.riskConfirmed && balances.palPay < -0.0001) return { ok: false, reason: 'NEGATIVE_PALPAY_RESULT', balances };

    const docIds: string[] = [];
    for (const item of normalizedNewTransactions) {
      const ref = adminDb.collection('transactions').doc();
      docIds.push(ref.id);
      tx.set(ref, { ...item, userId, id: ref.id });
    }
    if (receiptRef) {
      tx.set(receiptRef, {
        userId,
        receiptId,
        status: 'completed',
        docIds,
        operationIds: normalizedNewTransactions.map((item: any) => item.operationId),
        itemCount: normalizedNewTransactions.length,
        balances,
        receiptMeta: opts.receiptMeta || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return { ok: true, docIds, balances };
  });
}

export async function atomicPayDebt(
  userId: string,
  newTx: FinancialTransactionInput,
  creditorKey: string,
  opts: { riskConfirmed?: boolean } = {}
): Promise<{ ok: true; docId: string } | { ok: false; reason: string; remaining?: number; available?: number }> {
  return adminDb.runTransaction(async (tx: any) => {
    const snap = await tx.get(
      adminDb.collection('transactions').where('userId', '==', userId)
    );
    // Re-compute the creditor's remaining debt AT THIS INSTANT (not the cached value).
    // This is the critical race fix: concurrent payments see the same snapshot only
    // if they're not in the same transaction. With runTransaction, the second payment
    // sees the first payment's write.
    const docs = snap.docs;
    const transactions = plainTransactions(docs);
    const recomputedRemaining = calculateCreditorRemaining(transactions, creditorKey);
    const amount = parsePositiveFinancialAmount(newTx.amount);
    if (amount > recomputedRemaining + 0.0001) {
      return {
        ok: false,
        reason: 'OVERPAYMENT_ATOMIC',
        remaining: Math.round(recomputedRemaining * 100) / 100,
      };
    }
    // Also check the source account has funds.
    const balances = calculateBalances(plainTransactions(docs));
    const fromAccount = String(newTx.fromAccount || newTx.account || 'cash');
    const available = fromAccount === 'palPay' ? balances.palPay : balances.cash;
    if (amount > available + 0.0001) {
      return {
        ok: false,
        reason: 'INSUFFICIENT_FUNDS_ATOMIC',
        available: Math.round(available * 100) / 100,
      };
    }
    // Approved — write inside the transaction.
    const newRef = adminDb.collection('transactions').doc();
    tx.set(newRef, { ...newTx, userId, id: newRef.id });
    return { ok: true, docId: newRef.id };
  });
}

