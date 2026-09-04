/**
 * V6 Authentication & Authorization Module
 *
 * SECURITY INVARIANTS:
 * - Valid verified Firebase authentication => authenticated request.
 * - Invalid / expired / forged / missing authentication => HTTP 401.
 * - NEVER: authentication failure => default authenticated user.
 *
 * Replaces the V5 masrofi_token_ unsigned-token bypass and the
 * usr_zozototo_default shared-default-identity fallback (CF-1, HF-4).
 *
 * For Safari/mobile "direct login" without popups, we now use Firebase
 * Anonymous Auth (server-side minted custom token) and verify via the
 * Firebase Admin SDK. No unsigned identity is ever accepted.
 */
import { adminAuth, adminDb } from './firebaseAdmin';

/** Result of an authentication attempt. */
export interface AuthResult {
  ok: boolean;
  status: number;
  uid?: string;
  email?: string;
  token?: string;       // verified Firebase ID token (when ok)
  error?: string;
}

export type IdTokenVerifier = (token: string) => Promise<{ uid?: string; email?: string }>;

/**
 * Verify a Bearer token. Returns AuthResult.ok=false on any failure.
 * Never falls back to a default user.
 *
 * The verifier dependency is injectable for behavioral tests; production callers
 * use Firebase Admin verifyIdToken by default.
 */
export async function verifyBearer(
  authHeader: string | undefined,
  verifyIdToken: IdTokenVerifier = (token) => adminAuth.verifyIdToken(token),
): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing or malformed Authorization header' };
  }
  const token = authHeader.split('Bearer ')[1]?.trim();
  if (!token) {
    return { ok: false, status: 401, error: 'Empty bearer token' };
  }
  // CF-1: explicitly reject the legacy unsigned masrofi_token_ format.
  if (token.startsWith('masrofi_token_')) {
    return { ok: false, status: 401, error: 'Unsigned legacy tokens are no longer accepted' };
  }
  try {
    const decoded = await verifyIdToken(token);
    if (!decoded?.uid) {
      return { ok: false, status: 401, error: 'Token has no uid' };
    }
    return { ok: true, status: 200, uid: decoded.uid, email: decoded.email, token };
  } catch (err: any) {
    // NEVER fall back. Auth failure = 401.
    const msg = err?.code || err?.message || 'verifyIdToken failed';
    return { ok: false, status: 401, error: `Authentication failed: ${msg}` };
  }
}

/** Express middleware. Strict — no default user fallback. */
export const authMiddleware = async (req: any, res: any, next: any) => {
  const result = await verifyBearer(req.headers.authorization);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error || 'Unauthorized' });
  }
  req.user = { uid: result.uid!, email: result.email, token: result.token };
  return next();
};

/**
 * Legacy Safari/Mobile email-only direct login is intentionally disabled.
 *
 * Security invariant: possession of an email address is NOT proof of identity.
 * The server must never mint a Firebase Custom Token from an unverified email claim.
 * Safari/mobile authentication now uses Firebase's provider-controlled redirect flow
 * on the client, where Google/Firebase performs the identity proof.
 */
export async function issueDirectLoginToken(_email: string): Promise<{
  success: boolean;
  error?: string;
}> {
  return {
    success: false,
    error: 'EMAIL_ONLY_DIRECT_LOGIN_DISABLED',
  };
}

/**
 * Server-side ownership enforcement for Firestore mutations.
 * Throws OwnershipError if the document does not belong to the requesting user.
 *
 * Used by /api/sync (CF-2) and other endpoints where client supplies document IDs.
 */
export class OwnershipError extends Error {
  status: number;
  constructor(message: string, status: number = 403) {
    super(message);
    this.status = status;
    this.name = 'OwnershipError';
  }
}

/**
 * Verify a document at (collection, docId) belongs to `uid`.
 * Returns the existing doc data or null if not found.
 * Throws OwnershipError if the doc exists but is owned by a different user.
 */
export async function assertOwnership(collection: string, docId: string, uid: string): Promise<any | null> {
  const snap = await adminDb.collection(collection).doc(docId).get();
  if (!snap.exists) return null;
  const data = snap.data() as any;
  if (!data || data.userId !== uid) {
    throw new OwnershipError(`Document ${collection}/${docId} is not owned by user ${uid}`, 403);
  }
  return data;
}

/**
 * WS authentication via initial auth message (CF-1, HF-4).
 * The first message on the WebSocket MUST be {type:'auth', token}.
 * Server validates via verifyBearer before processing audio or tools.
 */
export interface WSAuthState {
  authenticated: boolean;
  uid?: string;
  email?: string;
  token?: string;
}
