# FullPrompt Financial Audit V3

Changes in this pass:
- Preserved voice/audio/VAD/WebSocket thresholds and scheduling logic.
- Added separate assistant relationship context (name != relationship).
- Added playful, warm, and romantic personas without changing financial tool rules.
- Fixed wipeAllUserData memory path to match canonical users/{uid}/memory storage.
- Added ownership verification before deleting commitments.
- Made report deletion UI wait for backend success before removing local UI state.
- Made budget and commitment UI mutations verify backend success before reporting/refreshing.

Known items deliberately not overclaimed:
- Notifications are still transient in-memory events; persistent notification center requires a storage model decision.
- Predictive summary remains a deterministic current-balance-minus-commitments projection, not a statistical forecast.
- Full dependency install/typecheck could not complete in the audit sandbox within the execution time limit.
- Supabase migration is intentionally deferred until the financial baseline is accepted.
