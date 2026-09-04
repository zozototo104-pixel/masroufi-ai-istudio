export type ImportEnvelopeValidationFailure = {
  section: string;
  index: string | number;
  code: string;
  message: string;
};

export type ImportEnvelopeValidationResult =
  | { ok: true; isTransactionArrayImport: boolean; backupObject: Record<string, unknown> }
  | { ok: false; reason: 'IMPORT_BACKUP_VALIDATION_FAILED'; message: string; validationFailures: ImportEnvelopeValidationFailure[] };

const KNOWN_IMPORT_SECTIONS = ['transactions', 'budgets', 'commitments', 'reports', 'memory'] as const;

function isPlainBackupObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function validateImportEnvelope(payload: unknown): ImportEnvelopeValidationResult {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      reason: 'IMPORT_BACKUP_VALIDATION_FAILED',
      message: 'لم يتم استيراد النسخة لأن ملف النسخة الاحتياطية غير صالح. لم يتم حذف أو تغيير البيانات الحالية.',
      validationFailures: [{
        section: 'backup',
        index: '*',
        code: 'INVALID_BACKUP_PAYLOAD',
        message: 'ملف النسخة الاحتياطية يجب أن يكون كائناً أو مصفوفة عمليات.',
      }],
    };
  }

  const isTransactionArrayImport = Array.isArray(payload);
  const backupObject = isTransactionArrayImport ? {} : isPlainBackupObject(payload) ? payload : {};
  const hasRecognizedBackupSection = isTransactionArrayImport
    || KNOWN_IMPORT_SECTIONS.some((section) => Object.prototype.hasOwnProperty.call(backupObject, section));

  if (!hasRecognizedBackupSection) {
    return {
      ok: false,
      reason: 'IMPORT_BACKUP_VALIDATION_FAILED',
      message: 'لم يتم استيراد النسخة لأنها لا تحتوي أي قسم معروف للاستعادة. لم يتم حذف أو تغيير البيانات الحالية.',
      validationFailures: [{
        section: 'backup',
        index: '*',
        code: 'EMPTY_OR_UNRECOGNIZED_BACKUP',
        message: 'النسخة الاحتياطية يجب أن تحتوي transactions أو budgets أو commitments أو reports أو memory.',
      }],
    };
  }

  return { ok: true, isTransactionArrayImport, backupObject };
}
