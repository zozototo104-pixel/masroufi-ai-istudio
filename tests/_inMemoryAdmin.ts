/**
 * V6 test stub for firebase-admin.
 *
 * Provides an in-memory Firestore-like API that the auth module and tools
 * can use during tests. This is NOT a mock of behavior — it implements the
 * subset of Firestore we actually use (collection().doc().get/set/update/delete,
 * collection().where().get(), batch(), runTransaction()).
 *
 * This stub allows tests to verify:
 * - Auth: verifyBearer rejects forged/missing tokens
 * - Idempotency: same operationId executes once
 * - Financial invariants: calculateBalancesFromDocs respects all six rules
 * - Report totals: buildHierarchicalReport produces correct totalCash/PalPay
 * - Import/export: round-trip preserves semantics
 *
 * For tests that need to simulate Firestore failures, see `makeFailingAdminDb()`.
 */
import type * as adminFirestore from 'firebase-admin/firestore';

interface TestDoc { [k: string]: any; }
interface TestCollection { [docId: string]: TestDoc; }

interface AdminDbState {
  // path => docs. Path is the full collection path, e.g. "transactions" or
  // "users/uid1/memory" or "users/uid1/budgets".
  collections: Map<string, TestCollection>;
  // Tracks writes for assertions.
  writes: { op: 'set' | 'update' | 'delete'; path: string; data?: any }[];
  // Optional failure injector.
  failNextWrite?: boolean;
  failNextRead?: boolean;
}

export function makeInMemoryAdminDb(state?: AdminDbState) {
  const s: AdminDbState = state || { collections: new Map(), writes: [] };
  const ensureCol = (path: string): TestCollection => {
    if (!s.collections.has(path)) s.collections.set(path, {});
    return s.collections.get(path)!;
  };

  const fakeDoc = (colPath: string, id: string) => ({
    id,
    collectionPath: colPath,
    collection: (sub: string) => fakeCollection(`${colPath}/${id}/${sub}`),
    async get() {
      if (s.failNextRead) { s.failNextRead = false; throw new Error('Simulated read failure'); }
      const col = s.collections.get(colPath) || {};
      const data = col[id];
      return { exists: !!data, data: () => data, id };
    },
    async set(data: any, opts?: any) {
      if (s.failNextWrite) { s.failNextWrite = false; throw new Error('Simulated write failure'); }
      const col = ensureCol(colPath);
      col[id] = opts?.merge ? { ...(col[id] || {}), ...data } : { ...data };
      s.writes.push({ op: 'set', path: `${colPath}/${id}`, data: col[id] });
    },
    async update(data: any) {
      if (s.failNextWrite) { s.failNextWrite = false; throw new Error('Simulated write failure'); }
      const col = ensureCol(colPath);
      col[id] = { ...(col[id] || {}), ...data };
      s.writes.push({ op: 'update', path: `${colPath}/${id}`, data: col[id] });
    },
    async delete() {
      const col = s.collections.get(colPath) || {};
      delete col[id];
      s.writes.push({ op: 'delete', path: `${colPath}/${id}` });
    },
  });

  const fakeCollection = (colPath: string) => ({
    name: colPath,
    doc: (id?: string) => fakeDoc(colPath, id || `auto_${Date.now()}_${Math.random().toString(36).slice(2,8)}`),
    where: (field: string, _op: string, val: any) => ({
      get: async () => {
        if (s.failNextRead) { s.failNextRead = false; throw new Error('Simulated read failure'); }
        const col = s.collections.get(colPath) || {};
        const docs = Object.entries(col)
          .filter(([, d]) => d && d[field] === val)
          .map(([id, d]) => fakeDoc(colPath, id));
        // Attach a forEach for compatibility.
        const snap: any = {
          docs,
          size: docs.length,
          empty: docs.length === 0,
          forEach: (cb: any) => docs.forEach(cb),
        };
        return snap;
      },
      orderBy: () => fakeCollection(colPath).where(field, _op, val),
      limit: () => fakeCollection(colPath).where(field, _op, val),
    }),
    get: async () => {
      const col = s.collections.get(colPath) || {};
      const docs = Object.entries(col).map(([id]) => fakeDoc(colPath, id));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (cb: any) => docs.forEach(cb) };
    },
    add: async (data: any) => {
      const id = `auto_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      const col = ensureCol(colPath);
      col[id] = data;
      return fakeDoc(colPath, id);
    },
  });

  return {
    collection: (path: string) => fakeCollection(path),
    batch: () => {
      const ops: (() => Promise<void>)[] = [];
      return {
        set: (ref: any, data: any, opts?: any) => {
          ops.push(() => ref.set(data, opts));
        },
        delete: (ref: any) => { ops.push(() => ref.delete()); },
        update: (ref: any, data: any) => { ops.push(() => ref.update(data)); },
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    runTransaction: async (fn: any) => fn({
      get: async (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => { ref.set(data, opts); },
      update: (ref: any, data: any) => { ref.update(data); },
      delete: (ref: any) => { ref.delete(); },
    }),
    _state: s,
  };
}

/** Admin Auth stub: verifyIdToken rejects forged tokens, accepts valid ones. */
export function makeInMemoryAdminAuth(opts?: {
  validTokens?: Record<string, any>;  // token -> {uid, email}
}) {
  const valid = opts?.validTokens || {};
  return {
    async verifyIdToken(token: string) {
      if (token.startsWith('masrofi_token_')) {
        throw new Error('Unsigned legacy tokens are no longer accepted');
      }
      if (valid[token]) return valid[token];
      throw new Error('Invalid token');
    },
    async createCustomToken(uid: string, claims?: any) {
      return `custom_${uid}_${Date.now()}`;
    },
  };
}

export type InMemoryAdminDb = ReturnType<typeof makeInMemoryAdminDb>;
export type InMemoryAdminAuth = ReturnType<typeof makeInMemoryAdminAuth>;
