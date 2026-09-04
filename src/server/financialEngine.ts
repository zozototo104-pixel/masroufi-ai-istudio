/**
 * V6.2 — Financial Mutation Engine (ONE SOURCE OF TRUTH).
 *
 * CRITICAL INVARIANT: Both online calls AND offline replay MUST route through
 * this single engine. /api/sync MUST NOT be a financial backdoor.
 *
 * Before this module, offlineQueue.sendOpToServer() packaged any pending op as
 * a generic transaction document and POSTed to /api/sync, which did
 * doc.set(payload) — bypassing all financial validation (overpayment, insufficient
 * funds, debt semantics, etc.).
 *
 * V6.2 fix: the offline queue now stores COMMANDS (intent), not final documents.
 * When replaying, the server calls dispatchFinancialCommand() which routes to the
 * SAME tool functions used by online AI calls: addTransaction, transferMoney, payDebt,
 * sendPalPayPayment, updateTransaction, deleteTransaction.
 *
 * This means:
 *   - One financial validation engine.
 *   - Offline replay cannot bypass business rules.
 *   - Idempotency layer (runIdempotent + operationId) covers offline replay too.
 *   - /api/sync handles ONLY non-financial state (e.g., report edits, commitment
 *     status updates) — financial mutations go through /api/command.
 */
import { toolHandlers } from './tools';
import { runIdempotent } from './idempotency';

export type FinancialCommandType =
  | 'ADD_TRANSACTION'
  | 'TRANSFER_MONEY'
  | 'PAY_DEBT'
  | 'SEND_PALPAY_PAYMENT'
  | 'UPDATE_TRANSACTION'
  | 'DELETE_TRANSACTION';

export interface FinancialCommand {
  operationId: string;
  userId: string;       // server-overwritten with authenticated UID — client value rejected
  commandType: FinancialCommandType;
  args: any;            // tool arguments (NOT the final document)
  createdAt: string;
}

/** Maps command types to tool handler names. */
const COMMAND_TO_TOOL: Record<FinancialCommandType, string> = {
  ADD_TRANSACTION: 'add_transaction',
  TRANSFER_MONEY: 'transfer_money',
  PAY_DEBT: 'pay_debt',
  SEND_PALPAY_PAYMENT: 'send_palpay_payment',
  UPDATE_TRANSACTION: 'update_transaction',
  DELETE_TRANSACTION: 'delete_transaction',
};

/**
 * Dispatch a financial command through the canonical financial mutation engine.
 *
 * Flow:
 *   1. Server force-overwrites command.userId = authenticated UID (SECURITY: never trust client).
 *   2. runIdempotent checks operationId in Firestore. If already completed, returns cached.
 *   3. If cache miss, calls the SAME tool handler used by online AI calls.
 *   4. Tool handler applies ALL financial validation (overpayment, insufficient funds, debt guards, etc.).
 *   5. Result stored in idempotency_keys collection for future replays.
 *
 * @returns the tool handler's result (same shape as online call).
 */
export async function dispatchFinancialCommand(
  command: FinancialCommand,
  authenticatedUserId: string,
  idToken: string,
): Promise<any> {
  // V6.2 (FINDING-07 SYNC-AUTH-01): NEVER trust client-supplied userId.
  // The authenticated UID always wins. If client supplied a different userId,
  // we don't reject the command (the client may have queued it offline before
  // knowing the canonical UID), but we OVERWRITE with the authenticated UID.
  // The tool handlers themselves use the userId parameter to scope writes.
  const finalCommand: FinancialCommand = {
    ...command,
    userId: authenticatedUserId,
  };

  const toolName = COMMAND_TO_TOOL[finalCommand.commandType];
  if (!toolName) {
    return {
      success: false,
      error: `Unknown command type: ${finalCommand.commandType}`,
      operationId: finalCommand.operationId,
    };
  }

  const handler = toolHandlers[toolName];
  if (!handler) {
    return {
      success: false,
      error: `Tool handler not found: ${toolName}`,
      operationId: finalCommand.operationId,
    };
  }

  // Pass operationId through args so the tool handler + idempotency layer can use it.
  const argsWithOpId = {
    ...finalCommand.args,
    operationId: finalCommand.operationId,
  };

  // runIdempotent already wraps the handler via wrapWithDeduplication in toolHandlers.
  // But dispatchFinancialCommand may be called from /api/command (not the AI tool call path).
  // The handler is already wrapped, so calling it once is sufficient.
  // The idempotency layer will return cached result if operationId was already processed.
  try {
    const result = await handler(argsWithOpId, authenticatedUserId, idToken);
    return result;
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || 'command dispatch failed',
      operationId: finalCommand.operationId,
    };
  }
}

/**
 * Validates that a command type is a known financial command.
 * Used by /api/command endpoint to reject unknown command types.
 */
export function isValidFinancialCommandType(t: string): t is FinancialCommandType {
  return t in COMMAND_TO_TOOL;
}
