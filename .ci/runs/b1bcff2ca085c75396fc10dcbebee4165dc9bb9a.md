# CI Verification Report

Source commit: b1bcff2ca085c75396fc10dcbebee4165dc9bb9a
Run: 33746841517
Install: success
Tests: success
TypeScript: success
Build: success

## failing tests
```text
none
```

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 14s

67 packages are looking for funding
  run `npm fund` for details

9 moderate severity vulnerabilities

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```

## tests
```text
  ...
# Subtest: OFF-07: Login A → logout → Login B cannot see/sync A queue
ok 170 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 1.61236
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 171 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 1.335927
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 172 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.068027
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 173 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 8.93283
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 174 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 1.201846
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 175 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 1.309758
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 176 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 0.926116
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 177 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 1.480505
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 178 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 0.768642
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 179 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 0.663831
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 180 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 1.097128
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 181 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 0.710133
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 182 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 0.810407
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 183 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 0.666987
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 184 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 1.690081
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 185 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 1.041826
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 186 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 2.408673
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 187 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 1.051662
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 188 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 1.162913
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 189 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 1.048145
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 190 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.483943
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 191 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 2.051688
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 192 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 2.524853
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 193 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 0.571918
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 194 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 0.544244
  type: 'test'
  ...
1..194
# tests 194
# suites 0
# pass 194
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1285.200399
```

## lint
```text

> masrofi-ai@6.0.0 lint
> tsc --noEmit

```

## build
```text

> masrofi-ai@6.0.0 build
> vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs

[36mvite v6.4.3 [32mbuilding for production...[36m[39m
transforming...
[32m✓[39m 2672 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/[22m[32mindex.html                          [39m[1m[2m  1.02 kB[22m[1m[22m[2m │ gzip:   0.43 kB[22m
[2mdist/[22m[2massets/[22m[35mindex-D4SQXbaV.css           [39m[1m[2m 62.56 kB[22m[1m[22m[2m │ gzip:  10.47 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-charts-4uLKkS1u.js    [39m[1m[2m 53.47 kB[22m[1m[22m[2m │ gzip:  18.63 kB[22m[2m │ map:   225.59 kB[22m
[2mdist/[22m[2massets/[22m[36mindex-CPtnIsBR.js            [39m[1m[2m180.06 kB[22m[1m[22m[2m │ gzip:  45.88 kB[22m[2m │ map:   448.02 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-firebase-Bxq1IwUx.js  [39m[1m[2m338.23 kB[22m[1m[22m[2m │ gzip:  78.80 kB[22m[2m │ map: 2,305.57 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-COxJT0IA.js           [39m[1m[2m489.09 kB[22m[1m[22m[2m │ gzip: 152.53 kB[22m[2m │ map: 2,114.49 kB[22m
[32m✓ built in 3.62s[39m

  dist/server.cjs      572.2kb
  dist/server.cjs.map  907.4kb

⚡ Done in 21ms
```

