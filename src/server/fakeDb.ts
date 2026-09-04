import fs from 'fs';
import path from 'path';
import firebaseConfig from '../../firebase-applet-config.json';
import { adminDb } from './firebaseAdmin';

const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId;
const apiKey = firebaseConfig.apiKey;
const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents`;

/**
 * V6 (CF-5): DURABILITY GUARANTEE
 * --------------------------------
 *
 * The previous implementation accepted writes silently to memoryStore when
 * Firestore was unreachable, then returned success to the caller. This made
 * offline writes APPEAR durable to the UI/AI while actually being ephemeral
 * (Cloud Run local disk is wiped on cold start).
 *
 * V6 changes:
 *   - FakeDb.set/update/delete now return a WriteResult with an explicit
 *     `durability` field: 'committed' (Firestore write succeeded),
 *     'pending' (only in local store, NOT durable), or 'failed'.
 *   - The storage layer still attempts Firestore first, then REST fallback,
 *     then in-memory fallback — but it no longer lies about durability.
 *   - getBalance / getFinancialDecisionContext propagate `partial` flag so
 *     the AI and UI can refuse financial decisions on partial data.
 */

export type WriteDurability = 'committed' | 'pending' | 'failed';

export interface WriteResult {
  durability: WriteDurability;
  /** True if the write reached Firestore (committed). */
  synced: boolean;
  /** True if the write was buffered locally but NOT durable. */
  pending: boolean;
  /** Optional error message on failure. */
  error?: string;
}

const PERSISTENT_DB_FILE = path.join(process.cwd(), 'persisted_db.json');

// Global memory cache to prevent quota exhaustion and provide seamless offline/cached fallback.
// V6: this cache is BEST-EFFORT ONLY and never advertised as authoritative storage.
interface StoredDoc {
  collectionPath: string;
  id: string;
  data: any;
  updatedAt: number;
  syncedToCloud?: boolean;
  deleted?: boolean;
}

const memoryStore = new Map<string, StoredDoc>();
const queryCache = new Map<string, { docs: any[]; expiresAt: number }>();
let isSyncingToCloud = false;

function getDocKey(collectionPath: string, id: string) {
  return `${collectionPath}/${id}`;
}

function loadMemoryStoreFromDisk() {
  try {
    if (fs.existsSync(PERSISTENT_DB_FILE)) {
      const raw = fs.readFileSync(PERSISTENT_DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((item: StoredDoc) => {
          if (item && item.collectionPath && item.id) {
            // Keep in-memory version if newer
            const existing = memoryStore.get(getDocKey(item.collectionPath, item.id));
            if (!existing || (item.updatedAt || 0) >= (existing.updatedAt || 0)) {
              memoryStore.set(getDocKey(item.collectionPath, item.id), item);
            }
          }
        });
      }
    }
  } catch (e) {
    console.warn("Failed reading persisted db file:", e);
  }
}

// Initial load
loadMemoryStoreFromDisk();

function saveMemoryStoreToDisk() {
  try {
    const items = Array.from(memoryStore.values());
    fs.writeFileSync(PERSISTENT_DB_FILE, JSON.stringify(items, null, 2), 'utf8');
  } catch (e) {
    console.warn("Failed saving persisted db to disk:", e);
  }
}

// Attempt to sync any unsynced local documents to Firestore when quota/connectivity is available
async function syncUnsyncedToFirestore() {
  if (isSyncingToCloud) return;
  isSyncingToCloud = true;
  try {
    const unsynced = Array.from(memoryStore.values()).filter(item => item.syncedToCloud === false);
    if (unsynced.length === 0) {
      isSyncingToCloud = false;
      return;
    }
    console.log(`[Auto-Sync] Attempting to sync ${unsynced.length} local items to Firestore...`);
    for (const item of unsynced) {
      try {
        await adminDb.collection(item.collectionPath).doc(item.id).set(item.data, { merge: true });
        item.syncedToCloud = true;
      } catch (err: any) {
        if (err?.code === 8 || String(err?.message).includes('RESOURCE_EXHAUSTED') || String(err?.message).includes('Quota')) {
          console.warn("[Auto-Sync] Firestore quota still reached. Retaining local data safely.");
          break; // Stop loop, will retry in next cycle
        }
      }
    }
    saveMemoryStoreToDisk();
  } catch (syncErr) {
    console.warn("[Auto-Sync] Sync cycle error:", syncErr);
  } finally {
    isSyncingToCloud = false;
  }
}

// Background sync with Firestore Admin DB to populate memoryStore on startup and periodically sync
async function bootstrapFromFirestore() {}

bootstrapFromFirestore();

// Periodic retry to push pending local items whenever Firestore quota resets
// setInterval(() => { syncUnsyncedToFirestore(); }, 60 * 1000);

export function toFirestore(obj: any): any {
  if (obj === null || obj === undefined) return { nullValue: null };
  if (typeof obj === 'number') return Number.isInteger(obj) ? { integerValue: String(obj) } : { doubleValue: obj };
  if (typeof obj === 'boolean') return { booleanValue: obj };
  if (typeof obj === 'string') return { stringValue: obj };
  if (Array.isArray(obj)) return { arrayValue: { values: obj.map(toFirestore) } };
  if (typeof obj === 'object') {
    const fields: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) fields[k] = toFirestore(v);
    }
    return { mapValue: { fields } };
  }
}

export function fromFirestore(val: any): any {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('integerValue' in val) return parseInt(val.integerValue, 10);
  if ('doubleValue' in val) return val.doubleValue;
  if ('booleanValue' in val) return val.booleanValue;
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fromFirestore);
  if ('mapValue' in val) {
    const obj: any = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      obj[k] = fromFirestore(v);
    }
    return obj;
  }
  return val;
}

export class FakeDb {
  token: string;
  constructor(token: string) { this.token = token; }
  collection(name: string) { return new FakeCollection(name, this.token); }
  batch() { return new FakeBatch(this.token); }
}

export class FakeCollection {
  name: string;
  token: string;
  _where: any[] = [];
  _orderBy: any = null;
  _limit: number | null = null;
  constructor(name: string, token: string) { this.name = name; this.token = token; }
  doc(id?: string) { return new FakeDoc(this.name, id || (Date.now().toString() + Math.random().toString().slice(2)), this.token); }
  where(field: string, op: string, val: any) {
    this._where.push({ field, op, val });
    return this;
  }
  orderBy(field: string, dir: string) {
    this._orderBy = { field, dir };
    return this;
  }
  limit(num: number) {
    this._limit = num;
    return this;
  }
  
  async get() {
    try {
      let queryRef: any = adminDb.collection(this.name);
      for (const w of this._where) {
        queryRef = queryRef.where(w.field, w.op, w.val);
      }
      if (this._orderBy) queryRef = queryRef.orderBy(this._orderBy.field, this._orderBy.dir);
      if (this._limit) queryRef = queryRef.limit(this._limit);
      
      const snap = await queryRef.get();
      
      const finalDocs: any[] = [];
      const cloudIds = new Set<string>();
      
      snap.forEach((doc: any) => {
        cloudIds.add(doc.id);
        const memKey = getDocKey(this.name, doc.id);
        const existing = memoryStore.get(memKey);
        
        let docData = doc.data();
        let useCloud = true;
        
        if (existing && existing.syncedToCloud === false) {
          if (existing.deleted) return; // Skip locally deleted
          docData = existing.data;
          useCloud = false;
        }
        
        if (useCloud) {
          memoryStore.set(memKey, {
            collectionPath: this.name,
            id: doc.id,
            data: docData,
            updatedAt: Date.now(),
            syncedToCloud: true
          });
        }
        
        finalDocs.push({ id: doc.id, data: () => docData, exists: true });
      });
      
      // Add local unsynced inserts
      for (const [key, item] of memoryStore.entries()) {
        if (item.collectionPath === this.name && item.syncedToCloud === false && !item.deleted && !cloudIds.has(item.id)) {
          let pass = true;
          for (const w of this._where) {
            const itemVal = item.data?.[w.field];
            if (w.field === 'userId') { if (typeof itemVal !== 'string' || itemVal !== w.val) { pass = false; break; } } else if (itemVal !== w.val) {
              pass = false; break;
            }
          }
          if (pass) {
            finalDocs.push({ id: item.id, data: () => item.data, exists: true });
          }
        }
      }

      saveMemoryStoreToDisk();
      
      return { docs: finalDocs, partial: false } as any;
    } catch (e: any) {
      const memDocs = this.queryMemory();
      return { docs: memDocs.docs, partial: true, error: e.message };
    }
  }

  private queryMemory() {
    loadMemoryStoreFromDisk();
    let matched: any[] = [];
    const allInCol: any[] = [];

    for (const [key, item] of memoryStore.entries()) {
      if (item.collectionPath === this.name) {
        allInCol.push({ id: item.id, exists: true, data: () => item.data });
        let pass = true;
        for (const w of this._where) {
          const itemVal = item.data?.[w.field];
          // User matching: match all variants of the user id or if not specified
          if (w.field === 'userId') { if (typeof itemVal !== 'string' || itemVal !== w.val) { pass = false; break; } } else if (itemVal !== w.val) {
            pass = false;
            break;
          }
        }
        if (pass) {
          matched.push({ id: item.id, exists: true, data: () => item.data });
        }
      }
    }

    if (this._orderBy) {
      const field = this._orderBy.field;
      const desc = this._orderBy.dir === 'desc';
      matched.sort((a, b) => {
        const valA = a.data()?.[field] || 0;
        const valB = b.data()?.[field] || 0;
        return desc ? (valB > valA ? 1 : -1) : (valA > valB ? 1 : -1);
      });
    }

    if (this._limit && this._limit > 0) {
      matched = matched.slice(0, this._limit);
    }

    return { docs: matched };
  }
}

export class FakeDoc {
  collectionPath: string;
  id: string;
  token: string;
  constructor(collectionPath: string, id: string, token: string) { this.collectionPath = collectionPath; this.id = id; this.token = token; }
  collection(name: string) {
    return new FakeCollection(`${this.collectionPath}/${this.id}/${name}`, this.token);
  }
  async get() {
    const memKey = getDocKey(this.collectionPath, this.id);

    // Firestore is authoritative whenever the cloud read succeeds, including
    // the "document does not exist" case. Never resurrect a stale memory copy.
    try {
      const snap = await adminDb.collection(this.collectionPath).doc(this.id).get();
      if (snap.exists) {
        const data = snap.data();
        memoryStore.set(memKey, {
          collectionPath: this.collectionPath,
          id: this.id,
          data,
          updatedAt: Date.now(),
          syncedToCloud: true,
        });
        saveMemoryStoreToDisk();
        return { exists: true, data: () => data, partial: false };
      }

      memoryStore.delete(memKey);
      saveMemoryStoreToDisk();
      return { exists: false, data: () => null, partial: false };
    } catch (e: any) {
      const mem = memoryStore.get(memKey);
      if (mem && !mem.deleted) {
        return {
          exists: true,
          data: () => mem.data,
          partial: true,
          error: e?.message || 'cloud document read failed',
        };
      }
      return {
        exists: false,
        data: () => null,
        partial: true,
        error: e?.message || 'cloud document read failed',
      };
    }
  }
  async set(data: any): Promise<WriteResult> {
    queryCache.clear();
    const memKey = getDocKey(this.collectionPath, this.id);
    let synced = false;
    let lastError: string | undefined;

    try {
      await adminDb.collection(this.collectionPath).doc(this.id).set(data, { merge: true });
      synced = true;
    } catch (e: any) {
      lastError = e?.message || 'admin SDK write failed';
      try {
        const body = { fields: toFirestore(data).mapValue.fields };
        const response = await fetch(`${baseUrl}/${this.collectionPath}/${encodeURIComponent(this.id)}?key=${apiKey}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(`Firestore REST write failed: ${response.status}`);
        synced = true;
      } catch (err: any) {
        synced = false;
        lastError = err?.message || lastError;
      }
    }

    memoryStore.set(memKey, {
      collectionPath: this.collectionPath,
      id: this.id,
      data,
      updatedAt: Date.now(),
      syncedToCloud: synced
    });
    saveMemoryStoreToDisk();

    // V6: return explicit durability status. Caller MUST inspect this.
    const durability: WriteDurability = synced ? 'committed' : 'pending';
    return { durability, synced, pending: !synced, error: lastError };
  }
  async update(data: any): Promise<WriteResult> {
    queryCache.clear();
    const memKey = getDocKey(this.collectionPath, this.id);
    const existing = memoryStore.get(memKey);
    const merged = { ...(existing?.data || {}), ...data };
    let synced = false;
    let lastError: string | undefined;

    try {
      await adminDb.collection(this.collectionPath).doc(this.id).update(data);
      synced = true;
    } catch (e: any) {
      lastError = e?.message || 'admin SDK update failed';
      try {
        const body = { fields: toFirestore(data).mapValue.fields };
        const updateMask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join('&');
        const response = await fetch(`${baseUrl}/${this.collectionPath}/${encodeURIComponent(this.id)}?${updateMask}&key=${apiKey}`, {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!response.ok) throw new Error(`Firestore REST update failed: ${response.status}`);
        synced = true;
      } catch (err: any) {
        synced = false;
        lastError = err?.message || lastError;
      }
    }

    memoryStore.set(memKey, {
      collectionPath: this.collectionPath,
      id: this.id,
      data: merged,
      updatedAt: Date.now(),
      syncedToCloud: synced
    });
    saveMemoryStoreToDisk();

    const durability: WriteDurability = synced ? 'committed' : 'pending';
    return { durability, synced, pending: !synced, error: lastError };
  }
  async delete(): Promise<WriteResult> {
    queryCache.clear();
    const memKey = getDocKey(this.collectionPath, this.id);
    let synced = false;
    let lastError: string | undefined;

    try {
      await adminDb.collection(this.collectionPath).doc(this.id).delete();
      synced = true;
    } catch (e: any) {
      lastError = e?.message || 'admin SDK delete failed';
      try {
        const response = await fetch(`${baseUrl}/${this.collectionPath}/${encodeURIComponent(this.id)}?key=${apiKey}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${this.token}` }
        });
        if (!response.ok) throw new Error(`Firestore REST delete failed: ${response.status}`);
        synced = true;
      } catch (err: any) {
        synced = false;
        lastError = err?.message || lastError;
      }
    }

    if (synced) {
      memoryStore.delete(memKey);
    } else {
      memoryStore.set(memKey, {
        collectionPath: this.collectionPath,
        id: this.id,
        data: { deleted: true },
        updatedAt: Date.now(),
        syncedToCloud: false,
        deleted: true
      });
    }
    saveMemoryStoreToDisk();

    const durability: WriteDurability = synced ? 'committed' : 'pending';
    return { durability, synced, pending: !synced, error: lastError };
  }
}

export class FakeBatch {
  token: string;
  writes: any[] = [];
  constructor(token: string) { this.token = token; }
  set(doc: FakeDoc, data: any) {
    queryCache.clear();
    this.writes.push({ type: 'set', doc, data });
    return this;
  }
  delete(doc: FakeDoc) {
    queryCache.clear();
    this.writes.push({ type: 'delete', doc });
    return this;
  }
  async commit(): Promise<WriteResult> {
    queryCache.clear();
    try {
      const batch = adminDb.batch();
      for (const w of this.writes) {
        const ref = adminDb.collection(w.doc.collectionPath).doc(w.doc.id);
        if (w.type === 'set') batch.set(ref, w.data, { merge: true });
        if (w.type === 'delete') batch.delete(ref);
      }
      await batch.commit();

      // Only mutate the local mirror after Firestore has atomically committed.
      for (const w of this.writes) {
        const memKey = getDocKey(w.doc.collectionPath, w.doc.id);
        if (w.type === 'delete') {
          memoryStore.delete(memKey);
        } else {
          const existing = memoryStore.get(memKey);
          memoryStore.set(memKey, {
            collectionPath: w.doc.collectionPath,
            id: w.doc.id,
            data: { ...(existing?.data || {}), ...w.data },
            updatedAt: Date.now(),
            syncedToCloud: true,
          });
        }
      }
      saveMemoryStoreToDisk();
      return { durability: 'committed', synced: true, pending: false };
    } catch (e: any) {
      const error = e?.message || 'Firestore batch commit failed';
      console.warn('Admin batch commit failed:', e);
      // A batch is atomic in Firestore. Do not manufacture a local "success"
      // or replay individual financial writes after an unknown/failed commit.
      return { durability: 'failed', synced: false, pending: false, error };
    }
  }
}

export function clearAllLocalUserData(userId?: string) {
  loadMemoryStoreFromDisk();
  queryCache.clear();
  if (!userId) {
    memoryStore.clear();
  } else {
    for (const [key, item] of Array.from(memoryStore.entries())) {
      if (item.data?.userId === userId) {
        memoryStore.delete(key);
      }
    }
  }
  saveMemoryStoreToDisk();
}

export function getDb(token: string) { return new FakeDb(token); }



export function getPendingOps(userId?: string) {
  const pending = [];
  for (const item of memoryStore.values()) {
    if (item.syncedToCloud === false) {
      if (!userId || item.data?.userId === userId) {
        pending.push(item);
      }
    }
  }
  return pending;
}
