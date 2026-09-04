# V4 Notifications + Predictive Assistant

## Persistent notifications
- Replaced process-RAM notification queue with per-user persisted notifications at `users/{uid}/notifications`.
- Notifications survive Cloud Run restarts and Firestore temporary failures through the existing FakeDb fallback.
- Delivery is acknowledged persistently to prevent old toast replay.
- Added read acknowledgement endpoint.
- No polling interval was added; notifications are fetched only on the existing dashboard refresh path.

## Predictive assistant
- Replaced `balance - all commitments` with a 30-day projection.
- Uses already-loaded transactions and commitments, so forecast adds zero Firestore reads.
- Uses up to 90 days of actual history, with a minimum 30-day normalization window.
- Separates real income from debt borrowing and excludes transfers/debt payments from expense trend by relying on actual income/expense types.
- Adds commitments due in the next 30 days and overdue commitments.
- Shows forecast confidence based on available history.

## Additional integrity fix
- UI used `daysLeft` while backend returned `daysRemaining`; corrected so due-soon/overdue labels reflect backend data.

## Performance protection
- No changes to voice streaming, WebSocket, VAD, barge-in, speaker recognition, diarization, AI model, or thresholds.
- No new polling/background loop.
