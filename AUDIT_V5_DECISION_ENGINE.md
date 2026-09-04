# V5 Decision Engine

Added without changing voice/VAD/WebSocket/speaker thresholds.

- Unified on-demand financial decision context: balances, 90-day spending trend, daily average, 30-day projection, commitments and budgets.
- Pre-execution expense guard: insufficient funds are blocked; projected category-budget breaches require explicit confirmation before writing.
- Purchase assessment tool: calculates post-purchase liquidity, 30-day projected balance, daily-spend coverage and budget impact.
- Real local-market lookup tool: uses Gemini Google Search grounding only when explicitly requested. It returns sources and refuses to invent a Gaza seller/price when grounding is unavailable.
- Assistant prompt now distinguishes purchase intent from completed purchase, uses proactive intervention selectively, and requires source-backed market claims.
- No new polling or recurring Firestore reads were added. Market search is on-demand only.
- Existing post-write budget reads reuse the preflight snapshots where available.

Validation: TypeScript syntax transpilation passed for server.ts and src/server/tools.ts. Full tsc could not complete because npm dependency installation in the audit environment timed out and left missing @types packages.
