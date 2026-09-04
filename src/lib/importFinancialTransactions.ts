import { parsePositiveFinancialAmount } from './amount';
import { normalizeCreditorKey } from './balanceCalc';

export type PreparedImportedTransaction = { sourceId: string; docData: Record<string, unknown> };

export type ImportValidationFailure = {
  index: number;
  code: string;
  message: string;
};

export function prepareImportedFinancialTransactions(transactions: unknown[], userId: string, timestamp: () => string = () => new Date().toISOString()): {
  ok: true;
  entries: PreparedImportedTransaction[];
} | {
  ok: false;
  failures: ImportValidationFailure[];
} {
  const entries: PreparedImportedTransaction[] = [];
  const failures: ImportValidationFailure[] = [];
  const seenSourceIds = new Set<string>();
  const seenOperationIds = new Set<string>();
  const canonicalAccounts = new Set(['cash', 'palPay', 'debt']);

  for (const [index, rawTx] of transactions.entries()) {
    if (!rawTx || typeof rawTx !== 'object' || Array.isArray(rawTx)) {
      failures.push({ index, code: 'INVALID_TRANSACTION_OBJECT', message: 'سجل العملية ليس كائناً صالحاً.' });
      continue;
    }

    const t = rawTx as Record<string, unknown>;
    const amount = parsePositiveFinancialAmount(t.amount);
    if (amount <= 0) {
      failures.push({ index, code: 'INVALID_AMOUNT', message: 'كل عملية مستوردة يجب أن تحتوي مبلغاً موجباً صالحاً.' });
      continue;
    }

    const originalType = String(t.type || '').trim();
    if (!['income', 'expense', 'transfer'].includes(originalType)) {
      failures.push({ index, code: 'INVALID_TRANSACTION_TYPE', message: `نوع العملية غير صالح: ${originalType || '(missing)'}` });
      continue;
    }

    const sourceId = String(t.id || t.legacyId || '').trim();
    if (sourceId) {
      if (seenSourceIds.has(sourceId)) {
        failures.push({ index, code: 'DUPLICATE_TRANSACTION_ID', message: `معرف العملية مكرر داخل النسخة الاحتياطية: ${sourceId}` });
        continue;
      }
      seenSourceIds.add(sourceId);
    }

    const operationId = String(t.operationId || '').trim();
    if (operationId) {
      if (seenOperationIds.has(operationId)) {
        failures.push({ index, code: 'DUPLICATE_OPERATION_ID', message: `operationId مكرر داخل النسخة الاحتياطية: ${operationId}` });
        continue;
      }
      seenOperationIds.add(operationId);
    }

    const rawAccount = String(t.account || '').trim();
    const rawFromAccount = String(t.fromAccount || t.account || '').trim();
    const rawToAccount = String(t.toAccount || '').trim();

    if (originalType === 'transfer') {
      if (!canonicalAccounts.has(rawFromAccount) || !canonicalAccounts.has(rawToAccount)) {
        failures.push({ index, code: 'INVALID_TRANSFER_ACCOUNTS', message: 'التحويل المستورد يجب أن يحتوي fromAccount وtoAccount بقيم cash أو palPay أو debt.' });
        continue;
      }
      if (rawFromAccount === rawToAccount) {
        failures.push({ index, code: 'SAME_TRANSFER_ACCOUNT', message: 'التحويل المستورد لا يمكن أن يكون من الحساب نفسه إلى الحساب نفسه.' });
        continue;
      }
    } else if (!canonicalAccounts.has(rawAccount)) {
      failures.push({ index, code: 'INVALID_ACCOUNT', message: 'العملية المستوردة يجب أن تحتوي account بقيمة cash أو palPay أو debt.' });
      continue;
    }

    const merchant = String(t.merchant || '').trim();
    const creditor = String(t.creditor || merchant).trim();
    const transferTouchesDebt = originalType === 'transfer' && (rawFromAccount === 'debt' || rawToAccount === 'debt');
    const creditPurchase = originalType === 'expense' && rawAccount === 'debt';
    if ((transferTouchesDebt || creditPurchase) && !creditor) {
      failures.push({ index, code: 'MISSING_CREDITOR', message: 'أي عملية مستوردة تؤثر على الدين يجب أن تحدد الدائن.' });
      continue;
    }

    const now = timestamp();
    const docData: Record<string, unknown> = {
      userId,
      amount: Math.abs(amount),
      type: originalType,
      account: originalType === 'transfer' ? rawFromAccount : rawAccount,
      category: String(t.category || ''),
      subcategory: String(t.subcategory || ''),
      notes: String(t.notes || t.name || ''),
      merchant,
      necessity: String(t.necessity || ''),
      date: t.date || t.createdAt || now,
      createdAt: t.createdAt || now,
      importedAt: now,
    };

    // Restore reconstructs historical state; it must preserve semantics without
    // inventing missing business facts or replaying side effects/notifications.
    if (t.purchaseItem !== undefined) docData.purchaseItem = String(t.purchaseItem || '');
    if (t.beneficiary !== undefined) docData.beneficiary = String(t.beneficiary || '');
    if (t.necessitySource !== undefined) docData.necessitySource = String(t.necessitySource || '');
    if (t.necessityReason !== undefined) docData.necessityReason = String(t.necessityReason || '');
    if (t.transactionType) docData.transactionType = String(t.transactionType);
    if (creditor) docData.creditor = creditor;
    if (t.creditorKey) docData.creditorKey = String(t.creditorKey);
    if (!docData.creditorKey && creditor) docData.creditorKey = normalizeCreditorKey(creditor);
    if (operationId) docData.operationId = operationId;

    if (originalType === 'transfer') {
      docData.fromAccount = rawFromAccount;
      docData.toAccount = rawToAccount;
    }

    entries.push({ sourceId, docData });
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, entries };
}
