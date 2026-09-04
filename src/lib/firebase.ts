import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  GoogleAuthProvider, 
  signInWithPopup,
  signInWithRedirect,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  indexedDBLocalPersistence
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// Configure robust persistence for Safari and cross-platform browsers
try {
  setPersistence(auth, browserLocalPersistence).catch(() => {
    setPersistence(auth, indexedDBLocalPersistence).catch(() => {
      setPersistence(auth, browserSessionPersistence).catch(console.warn);
    });
  });
} catch (e) {
  console.warn("Persistence setup error:", e);
}

export const googleProvider = new GoogleAuthProvider();

/**
 * Safari/Mobile login uses Firebase's provider-controlled redirect flow.
 * The client never asks our server to mint an identity from an email address.
 * Google/Firebase performs the identity proof, and onAuthStateChanged restores
 * the authenticated user after the browser returns from the redirect.
 */
export const loginWithSafariDirect = async (_email?: string): Promise<{ success: boolean; redirecting?: boolean; error?: string }> => {
  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithRedirect(auth, googleProvider);
    return { success: true, redirecting: true };
  } catch (err: any) {
    console.error("Safari redirect login error:", err);
    return { success: false, error: err?.message || "فشل بدء تسجيل الدخول الآمن بواسطة Google" };
  }
};

export const loginWithGoogle = async (): Promise<{ success: boolean; user?: any; error?: string }> => {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    return { success: true, user: result.user };
  } catch (error: any) {
    console.warn("Google popup login error:", error);
    let errorMessage = "تعذر تسجيل الدخول بواسطة Google";
    if (error.code === 'auth/popup-blocked') {
      errorMessage = "قام متصفح Safari بحظر النافذة المنبثقة. يمكنك استخدام زر «الدخول المباشر السريع» بالأسفل للدخول الفوري دون نوافذ منبثقة.";
    } else if (error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') {
      errorMessage = "تم إغلاق نافذة تسجيل الدخول قبل إتمام العملية.";
    } else if (error.code === 'auth/network-request-failed') {
      errorMessage = "تعذر الاتصال بالشبكة، يرجى التحقق من اتصال الإنترنت.";
    } else if (error.message) {
      errorMessage = error.message;
    }
    return { success: false, error: errorMessage };
  }
};

export const logout = async () => {
  try {
    localStorage.removeItem('masrofi_direct_session');
    await signOut(auth);
  } catch (error) {
    localStorage.removeItem('masrofi_direct_session');
    console.error("Logout failed", error);
  }
};

