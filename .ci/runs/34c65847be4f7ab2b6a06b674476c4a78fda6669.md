# CI Verification Report

Source commit: 34c65847be4f7ab2b6a06b674476c4a78fda6669
Run: 33439727270
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

added 543 packages, and audited 544 packages in 13s

67 packages are looking for funding
  run `npm fund` for details

6 moderate severity vulnerabilities

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
ok 148 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 2.044226
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 149 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 1.262874
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 150 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.408214
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 151 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 10.518573
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 152 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 2.755393
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 153 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 2.094571
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 154 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 0.963462
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 155 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 2.351062
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 156 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 1.05452
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 157 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 0.881755
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 158 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 1.694827
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 159 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 1.120737
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 160 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 1.452266
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 161 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 1.064211
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 162 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 2.518756
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 163 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 1.752875
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 164 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 3.389253
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 165 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 1.931004
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 166 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 1.981407
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 167 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 1.85885
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 168 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.772251
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 169 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 2.200634
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 170 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 5.744981
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 171 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 1.183697
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 172 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 0.85016
  type: 'test'
  ...
1..172
# tests 172
# suites 0
# pass 172
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1671.05357
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
[2mdist/[22m[2massets/[22m[35mindex-Bt_cRHQ_.css           [39m[1m[2m 62.65 kB[22m[1m[22m[2m │ gzip:  10.49 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-charts-Igz_b-4m.js    [39m[1m[2m 53.47 kB[22m[1m[22m[2m │ gzip:  18.63 kB[22m[2m │ map:   225.59 kB[22m
[2mdist/[22m[2massets/[22m[36mindex-CpgDhS5K.js            [39m[1m[2m167.83 kB[22m[1m[22m[2m │ gzip:  43.69 kB[22m[2m │ map:   413.63 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-firebase-AwKXYE9y.js  [39m[1m[2m338.23 kB[22m[1m[22m[2m │ gzip:  78.80 kB[22m[2m │ map: 2,305.57 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-Bd_WsFzF.js           [39m[1m[2m488.61 kB[22m[1m[22m[2m │ gzip: 152.50 kB[22m[2m │ map: 2,113.40 kB[22m
[32m✓ built in 4.63s[39m

  dist/server.cjs      503.7kb
  dist/server.cjs.map  789.6kb

⚡ Done in 25ms
```

