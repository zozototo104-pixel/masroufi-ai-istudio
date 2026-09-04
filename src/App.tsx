/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, ChangeEvent, FormEvent } from 'react';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { motion } from 'motion/react';
import { Mic, MicOff, AlertCircle, Loader2, Volume2, TrendingUp, TrendingDown, PiggyBank, Settings, FileText, X, Download, Printer, List, CheckCircle, Bell, LogIn, LogOut, Camera, MessageSquare, Send, Target, Calendar, Share2, Copy, ShieldAlert, Sparkles, Check, Trash2, HardDrive, ArrowUpDown, Mail, Lock, KeyRound, Phone, Code2, Brain } from 'lucide-react';
import { useGeminiLive } from './lib/useGeminiLive';
import MindMapChart from './components/MindMapChart';
import { DataBackupModal } from './components/DataBackupModal';
import { FloatingAssistant } from './components/FloatingAssistant';
import { auth, loginWithGoogle, loginWithSafariDirect, logout } from './lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';

import { buildHierarchicalReport, buildWordDocumentContent, buildWhatsAppReportText, matchesArabicCategory } from './lib/reportUtils';
import { calculateFinancialFitness } from './lib/fitnessScore';
import { calculateBalances } from './lib/balanceCalc';
import { clearPendingOpsForUser, syncPendingOps, getPendingCount, migrateLegacyPendingOps, enqueuePendingOp, type FinancialCommandType } from './lib/offlineQueue';

function normalizeScannedReceiptDateInput(value: string): string {
  const normalizedDigits = String(value || '')
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .trim();
  const isoWithTime = normalizedDigits.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T\s]/);
  if (isoWithTime) return `${isoWithTime[1]}-${isoWithTime[2].padStart(2, '0')}-${isoWithTime[3].padStart(2, '0')}`;
  const iso = normalizedDigits.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const slash = normalizedDigits.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, '0')}-${slash[1].padStart(2, '0')}`;
  const eightDigits = normalizedDigits.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (eightDigits) return `${eightDigits[3]}-${eightDigits[2]}-${eightDigits[1]}`;
  const sevenDigits = normalizedDigits.match(/^(\d{2})(\d)(\d{4})$/);
  if (sevenDigits) return `${sevenDigits[3]}-0${sevenDigits[2]}-${sevenDigits[1]}`;
  return normalizedDigits;
}

function isCompleteScannedReceiptDate(value: unknown): boolean {
  const normalized = normalizeScannedReceiptDateInput(String(value || ''));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

export default function App() {
  const [user, setUser] = useState<any | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [idToken, setIdToken] = useState<string | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const [showBudgets, setShowBudgets] = useState(false);
  const [showCommitments, setShowCommitments] = useState(false);
  const [showSavings, setShowSavings] = useState(false);
  const [showDataBackup, setShowDataBackup] = useState(false);
  const [showScannerResult, setShowScannerResult] = useState<any>(null);
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<{role: string, text: string}[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [interruptedFeedback, setInterruptedFeedback] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const scannerHasMissingDates = Boolean(showScannerResult?.items?.some((item: any) => !isCompleteScannedReceiptDate(item?.date)));
  const cloudProbeFailuresRef = useRef(0);

  const rememberCloudConnected = async () => {
    cloudProbeFailuresRef.current = 0;
    setIsOfflineMode(false);
    try { await idbSet('last_cloud_ok_at', Date.now()); } catch { /* ignore */ }
  };

  const markCloudProbeFailed = async () => {
    cloudProbeFailuresRef.current += 1;
    let lastOkAt = 0;
    try { lastOkAt = Number(await idbGet<number>('last_cloud_ok_at')) || 0; } catch { /* ignore */ }
    const recentlyConnected = lastOkAt > 0 && Date.now() - lastOkAt < 5 * 60 * 1000;
    // Do not flip the badge to local because of one transient health/Firestore
    // probe failure during Render cold start, Gemini pressure, or temporary quota.
    // Real API success turns it back to connected; only repeated failures or no
    // recent cloud success should show local/offline.
    if (!recentlyConnected || cloudProbeFailuresRef.current >= 3) setIsOfflineMode(true);
  };

  useEffect(() => {
    // navigator.onLine is unreliable on iOS/Safari and may report false while fetch works.
    // Treat real API success as the source of truth; browser offline event is only a hint.
    const probeCloud = async () => {
      try {
        const res = await fetch('/api/cloud-health', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data?.firestore === 'read-write-ok') await rememberCloudConnected();
        else await markCloudProbeFailed();
      } catch {
        await markCloudProbeFailed();
      }
    };
    const handleOnline = () => { void probeCloud(); };
    const handleOffline = () => { void probeCloud(); };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [authEmail, setAuthEmail] = useState('');

  const [transactions, setTransactions] = useState<any[]>([]);
  const [reportsList, setReportsList] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [activeReport, setActiveReport] = useState<any>(null);
  const [budgetsData, setBudgetsData] = useState<any>({ budgets: [], totalBudget: 0, totalSpent: 0 });
  const [commitments, setCommitments] = useState<any[]>([]);
  const [savingsGoals, setSavingsGoals] = useState<any[]>([]);

  // Helper to extract relevant transactions for a report dynamically and strictly
  const getReportTransactions = (report: any | null, allTransactions: any[]) => {
    if (!report) return allTransactions;
    
    const targetCat = report.category && report.category !== 'all' && report.category !== 'الكل' && report.category !== 'كافة البنود' && report.category !== 'التقرير الشامل'
      ? report.category 
      : (report.title && !report.title.includes('شامل') && !report.title.includes('كافة البنود') && !report.title.includes('الشامل') ? report.title : '');

    const isSpecificCategory = Boolean(targetCat);

    if (isSpecificCategory) {
      // If report already has saved transactions, clean/filter them to guarantee no cross-category leaks
      if (Array.isArray(report.transactions) && report.transactions.length > 0) {
        const filtered = report.transactions.filter(t => matchesArabicCategory(t, targetCat));
        return filtered;
      }
      // If report has no transactions array, match from live allTransactions
      const matched = allTransactions.filter(t => matchesArabicCategory(t, targetCat));
      return matched;
    }

    if (Array.isArray(report.transactions) && report.transactions.length > 0) {
      return report.transactions;
    }
    return allTransactions;
  };
  
  // New commitment form state
  const [newCommitmentTitle, setNewCommitmentTitle] = useState('');
  const [newCommitmentAmount, setNewCommitmentAmount] = useState('');
  const [newCommitmentDate, setNewCommitmentDate] = useState('');
  const [newCommitmentCategory, setNewCommitmentCategory] = useState('أقساط والتزامات');

  // Savings goal form state
  const [newSavingsName, setNewSavingsName] = useState('');
  const [newSavingsTarget, setNewSavingsTarget] = useState('');
  const [newSavingsDurationMonths, setNewSavingsDurationMonths] = useState('12');
  const [savingsContributionGoalId, setSavingsContributionGoalId] = useState('');
  const [savingsContributionAmount, setSavingsContributionAmount] = useState('');
  const [isSavingsSaving, setIsSavingsSaving] = useState(false);

  // Budget edit state
  const [editingBudgetCat, setEditingBudgetCat] = useState<string | null>(null);
  const [editingBudgetLimit, setEditingBudgetLimit] = useState('');

  // Settings State
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('masrofi_api_key') || '');
  const [voice, setVoice] = useState(() => {
    const savedVoice = localStorage.getItem('masrofi_voice');
    return savedVoice === 'Puck' || savedVoice === 'Zephyr' ? savedVoice : 'Zephyr';
  });
  const [persona, setPersona] = useState(() => localStorage.getItem('masrofi_persona') || 'friendly');
  const [userName, setUserName] = useState(() => localStorage.getItem('masrofi_user_name') || 'أبو مصعب');
  const [aiName, setAiName] = useState(() => localStorage.getItem('masrofi_ai_name') || 'مصروفي');
  const [aiRelationship, setAiRelationship] = useState(() => localStorage.getItem('masrofi_ai_relationship') || '');
  
  // Assistant Memory State
  const [userMemory, setUserMemory] = useState<Record<string, string>>({});
  const [newMemoryKey, setNewMemoryKey] = useState('');
  const [newMemoryValue, setNewMemoryValue] = useState('');
  const [isMemoryLoading, setIsMemoryLoading] = useState(false);

  // Personal voice cloning state. The raw recording stays in memory only until upload.
  const [customVoiceConfigured, setCustomVoiceConfigured] = useState(false);
  const [customVoiceBusy, setCustomVoiceBusy] = useState(false);
  const [customVoiceRecording, setCustomVoiceRecording] = useState(false);
  const [customVoiceConsent, setCustomVoiceConsent] = useState(false);
  const [customVoiceMessage, setCustomVoiceMessage] = useState('');
  const customVoiceRecorderRef = useRef<MediaRecorder | null>(null);
  const customVoiceStreamRef = useRef<MediaStream | null>(null);
  const customVoiceChunksRef = useRef<Blob[]>([]);
  
  const [isScanning, setIsScanning] = useState(false);
  const [isRecordingScannedReceipt, setIsRecordingScannedReceipt] = useState(false);

  const { connect, disconnect, isConnected, isRecording, status, error } = useGeminiLive({ apiKey, voice, persona, idToken, userName, aiName, relationship: aiRelationship });

  // Basic UI state
  const [balance, setBalance] = useState(0);
  const [cash, setCash] = useState(0);
  const [palPay, setPalPay] = useState(0);
  const [debt, setDebt] = useState(0);

  const printRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let mounted = true;
    // 1. Check local direct session first
    try {
      const savedSession = localStorage.getItem('masrofi_direct_session');
      if (savedSession) {
        const parsed = JSON.parse(savedSession);
        if (parsed && parsed.user && parsed.token) {
          setUser(parsed.user);
          setIdToken(parsed.token);
          setAuthLoading(false);
        }
      }
    } catch (e) {
      console.warn("Error reading direct session:", e);
    }

    // 2. Listen to Firebase Auth state
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!mounted) return;
      if (currentUser) {
        setUser(currentUser);
        try {
          const token = await currentUser.getIdToken();
          setIdToken(token);
        } catch (e) {
          console.warn("Failed getting idToken", e);
        }
      } else {
        const savedSession = localStorage.getItem('masrofi_direct_session');
        if (savedSession) {
          try {
            const parsed = JSON.parse(savedSession);
            if (parsed && parsed.user && parsed.token) {
              setUser(parsed.user);
              setIdToken(parsed.token);
            }
          } catch (e) {}
        } else {
          setUser(null);
          setIdToken(null);
        }
      }
      setAuthLoading(false);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleSafariDirectLogin = async (targetEmail?: string) => {
    const emailToUse = (targetEmail || authEmail).trim();
    if (!emailToUse) {
      setLoginError("يرجى إدخال البريد الإلكتروني للمتابعة.");
      return;
    }
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const res = await loginWithSafariDirect(emailToUse);
      // Firebase redirect navigation owns the authenticated session. After the
      // browser returns, onAuthStateChanged hydrates the user and fresh ID token.
      if (!res.success && res.error) {
        setLoginError(res.error);
      }
    } catch (err: any) {
      setLoginError(err?.message || "تعذر إتمام الدخول المباشر.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogin = async () => {
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const res = await loginWithGoogle();
      if (!res.success && res.error) {
        setLoginError(res.error);
      }
    } catch (err: any) {
      setLoginError(err?.message || "حدث خطأ أثناء محاولة تسجيل الدخول.");
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      localStorage.removeItem('masrofi_direct_session');
      // V6.1 (OFF-07): clear the per-user offline pending queue on logout.
      // Without this, Login B could sync Login A's pending ops to A's account (data leak).
      if (user?.uid) {
        try {
          await clearPendingOpsForUser(user.uid);
        } catch (e) {
          console.warn('Failed to clear pending ops on logout:', e);
        }
      }
      // V6 (CACHE-01, hidden risk): clear all user-scoped IndexedDB caches on logout
      // so a subsequent login by a different user on the same device cannot see the
      // previous user's data, even briefly. Without this, idb-keyval entries linger
      // and would be displayed until the new fetch() resolves.
      try {
        await idbSet('lkgs_transactions', []);
        await idbSet('lkgs_reports', []);
        await idbSet('lkgs_commitments', []);
        await idbSet('lkgs_budgets', { budgets: [], totalBudget: 0, totalSpent: 0 });
        // V6.2: clear ALL pending ops keys (v6_2 + legacy v6_1 + legacy original).
        await idbSet('masrofi_pending_ops', []);
        await idbSet('masrofi_pending_ops_v6_1', []);
        await idbSet('masrofi_pending_ops_v6_2', []);
      } catch (clearErr) {
        console.warn('Failed to clear IndexedDB on logout:', clearErr);
      }
      setUser(null);
      setIdToken(null);
      setTransactions([]);
      setReportsList([]);
      setBalance(0);
      setCash(0);
      setPalPay(0);
      setDebt(0);
      setUserMemory({});
      setBudgetsData({ budgets: [], totalBudget: 0, totalSpent: 0 });
      setCommitments([]);
      setNotifications([]);
      await logout();
    } catch (err) {
      console.error("Logout error:", err);
      setUser(null);
      setIdToken(null);
    }
  };

  useEffect(() => {
    localStorage.setItem('masrofi_api_key', apiKey);
    localStorage.setItem('masrofi_voice', voice);
    localStorage.setItem('masrofi_persona', persona);
    localStorage.setItem('masrofi_user_name', userName);
    localStorage.setItem('masrofi_ai_name', aiName);
    localStorage.setItem('masrofi_ai_relationship', aiRelationship);
  }, [apiKey, voice, persona, userName, aiName, aiRelationship]);

  useEffect(() => {
    if (!idToken) {
      setCustomVoiceConfigured(false);
      return;
    }
    let cancelled = false;
    fetch('/api/custom-voice', { headers: { Authorization: `Bearer ${idToken}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error('تعذر قراءة حالة صوتك.');
        return res.json();
      })
      .then((data) => { if (!cancelled) setCustomVoiceConfigured(Boolean(data?.configured)); })
      .catch((err) => { if (!cancelled) console.warn('[custom-voice] status', err); });
    return () => { cancelled = true; };
  }, [idToken]);

  const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('تعذر قراءة التسجيل.'));
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(blob);
  });

  const stopCustomVoiceCapture = () => {
    customVoiceStreamRef.current?.getTracks().forEach(track => track.stop());
    customVoiceStreamRef.current = null;
    customVoiceRecorderRef.current = null;
    setCustomVoiceRecording(false);
  };

  const startCustomVoiceRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setCustomVoiceMessage('هذا المتصفح لا يدعم تسجيل الصوت المطلوب.');
      return;
    }
    try {
      setCustomVoiceMessage('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const recorderOptions: MediaRecorderOptions = preferred
        ? { mimeType: preferred, audioBitsPerSecond: 32_000 }
        : { audioBitsPerSecond: 32_000 };
      const recorder = new MediaRecorder(stream, recorderOptions);
      customVoiceStreamRef.current = stream;
      customVoiceRecorderRef.current = recorder;
      customVoiceChunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size > 0) customVoiceChunksRef.current.push(event.data); };
      const autoStopTimer = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 30_000);
      recorder.onstop = async () => {
        window.clearTimeout(autoStopTimer);
        const blob = new Blob(customVoiceChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        stopCustomVoiceCapture();
        if (!customVoiceConsent) {
          setCustomVoiceMessage('أكد أن التسجيل لصوتك وأنك توافق على إنشاء نسخة صوتية منه.');
          return;
        }
        try {
          setCustomVoiceBusy(true);
          setCustomVoiceMessage('جارٍ إنشاء صوتك...');
          const audioBase64 = await blobToBase64(blob);
          const token = user && typeof user.getIdToken === 'function' ? await user.getIdToken(true) : idToken;
          const res = await fetch('/api/custom-voice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ audioBase64, mimeType: blob.type, consent: true }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error || 'تعذر إنشاء الصوت.');
          setCustomVoiceConfigured(true);
          setCustomVoiceMessage('تم إنشاء صوتك الشخصي. بقي مسار Puck/Zephyr الصوتي المستقر كما هو.');
        } catch (err: any) {
          setCustomVoiceMessage(err?.message || 'تعذر إنشاء الصوت.');
        } finally {
          setCustomVoiceBusy(false);
          customVoiceChunksRef.current = [];
        }
      };
      recorder.start(1000);
      setCustomVoiceRecording(true);
      setCustomVoiceMessage('تحدث بصوت طبيعي وواضح لمدة 20 إلى 30 ثانية. سيتوقف التسجيل تلقائيًا بعد 30 ثانية.');
    } catch (err: any) {
      stopCustomVoiceCapture();
      setCustomVoiceMessage(err?.message || 'تعذر الوصول إلى الميكروفون.');
    }
  };

  const finishCustomVoiceRecording = () => {
    const recorder = customVoiceRecorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  };

  const removeCustomVoice = async () => {
    if (!idToken || customVoiceBusy) return;
    try {
      setCustomVoiceBusy(true);
      const token = user && typeof user.getIdToken === 'function' ? await user.getIdToken(true) : idToken;
      const res = await fetch('/api/custom-voice', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'تعذر حذف الصوت.');
      setCustomVoiceConfigured(false);
      if (voice === 'Custom') setVoice('Zephyr');
      setCustomVoiceMessage('تم حذف صوتك الشخصي.');
    } catch (err: any) {
      setCustomVoiceMessage(err?.message || 'تعذر حذف الصوت.');
    } finally {
      setCustomVoiceBusy(false);
    }
  };

  useEffect(() => () => {
    try { customVoiceRecorderRef.current?.stop(); } catch { /* ignore */ }
    customVoiceStreamRef.current?.getTracks().forEach(track => track.stop());
  }, []);

  useEffect(() => {
    if (!idToken) return;

    const fetchData = async () => {
      try {
        const headers = { 'Authorization': `Bearer ${idToken}` };
        const cloudHealthRes = await fetch('/api/cloud-health', { cache: 'no-store' });
        const cloudHealth = await cloudHealthRes.json().catch(() => ({}));
        const cloudReady = cloudHealthRes.ok && cloudHealth?.firestore === 'read-write-ok';
        if (cloudReady) await rememberCloudConnected();
        else await markCloudProbeFailed();

        // V6.1 (OFF-04, OFF-05): attempt to sync pending offline ops at start of every refresh.
        // Server-side idempotency (runIdempotent + operationId) prevents duplication.
        if (cloudReady && user?.uid) {
          try {
            // V6.2 (FINDING-05): migrate any legacy pending ops from V6.1 schema.
            await migrateLegacyPendingOps(user.uid);
            const syncResult = await syncPendingOps(user.uid, idToken);
            if (syncResult.synced > 0) {
              console.log(`[offline] synced ${syncResult.synced} pending ops, ${syncResult.failed} failed, ${syncResult.remaining} remaining`);
            }
          } catch (syncErr) {
            console.warn('[offline] sync attempt failed:', syncErr);
          }
        }

        const notifRes = await fetch('/api/notifications', { headers });
        const notifData = await notifRes.json();
        if (notifData && notifData.notifications && notifData.notifications.length > 0) {
          setNotifications(prev => {
            const byId = new Map(prev.map((n: any) => [n.id, n]));
            for (const n of notifData.notifications) byId.set(n.id, n);
            return Array.from(byId.values());
          });
          notifData.notifications.forEach((n: any) => {
            setTimeout(() => {
              setNotifications(prev => prev.filter(item => item.id !== n.id));
            }, 4000);
          });
        }
        
        const txRes = await fetch('/api/transactions', { headers });
        const txData = await txRes.json();
        let finalTx = [];
        if (txRes.ok && txData && txData.transactions && !txData.partial) {
          await rememberCloudConnected(); // Cloud API succeeded; this is more reliable than navigator.onLine on iOS/Safari
          // Financial transactions are now synced only through offlineQueue -> /api/command.
          // Never merge legacy _unsynced transaction documents with cloud transactions here;
          // doing so can visually double balances even when Firestore has only one canonical record.
          finalTx = txData.transactions || [];
          await idbSet('lkgs_transactions', finalTx);
        } else {
          // The cloud connection badge is owned by real health/API successes.
          // A partial or bounded transaction response means the visible ledger may
          // fall back to cached display data, but it does not prove that the app is
          // offline, so do not flip the badge here.
          let cachedTx = (await idbGet<any[]>('lkgs_transactions')) || [];
          if (!Array.isArray(cachedTx)) cachedTx = [];
          const pending = (txData && txData.partial && txData.transactions) ? txData.transactions : [];
          const merged = new Map(cachedTx.map(t => [t.id, t]));
          pending.forEach(p => merged.set(p.id, { ...p, _unsynced: true }));
          finalTx = Array.from(merged.values()).filter(t => !t.deleted);
          finalTx.sort((a, b) => new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime());
        }
        
        if (finalTx.length > 0) {
          setTransactions(finalTx);
          // V6.1: use canonical balance calculator (mirrors backend calculateBalancesFromDocs).
          // This eliminates UI-vs-Backend-vs-Report divergence.
          const balances = calculateBalances(finalTx);
          setCash(balances.cash);
          setPalPay(balances.palPay);
          setDebt(balances.debt);
          setBalance(balances.total);
        } else {
          setTransactions([]);
          setCash(0);
          setPalPay(0);
          setDebt(0);
          setBalance(0);
        }

        const repRes = await fetch('/api/reports', { headers });
        const repData = await repRes.json();
        let finalRep = [];
        if (repRes.ok && repData && repData.reports && !repData.partial) {
          let cachedRep = (await idbGet<any[]>('lkgs_reports')) || [];
          if (!Array.isArray(cachedRep)) cachedRep = [];
          const unsyncedRep = cachedRep.filter(r => r._unsynced);
          if (unsyncedRep.length > 0) {
            await fetch('/api/sync', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ reports: unsyncedRep }) });
            const newRes = await fetch('/api/reports', { headers });
            const newData = await newRes.json();
            finalRep = newData.reports || [];
          } else {
            finalRep = repData.reports;
          }
          await idbSet('lkgs_reports', finalRep);
        } else {
          let cachedRep = (await idbGet<any[]>('lkgs_reports')) || [];
          if (!Array.isArray(cachedRep)) cachedRep = [];
          const pending = (repData && repData.partial && repData.reports) ? repData.reports : [];
          const merged = new Map(cachedRep.map(r => [r.id, r]));
          pending.forEach(p => merged.set(p.id, { ...p, _unsynced: true }));
          finalRep = Array.from(merged.values()).filter(r => !r.deleted).sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        }
        setReportsList(finalRep);

        const budRes = await fetch('/api/budgets', { headers });
        const budData = await budRes.json();
        
        let finalBudData = budData;
        if (!budRes.ok || !budData || !budData.budgets) {
          finalBudData = (await idbGet<any>('lkgs_budgets')) || { budgets: [], totalBudget: 0, totalSpent: 0 };
        } else if (budData.partial) {
          // If partial, the server couldn't read all transactions, so spendings are wrong.
          // We must recalculate spendings using our full local finalTx.
          const thisMonth = new Date().toISOString().slice(0, 7);
          const monthExpenses = finalTx.filter((t: any) => t.type === 'expense' && (t.date || '').startsWith(thisMonth));
          
          let totalBudget = 0;
          let totalSpent = 0;
          
          budData.budgets = budData.budgets.map((b: any) => {
             totalBudget += Number(b.limit) || 0;
             const catExpenses = monthExpenses.filter((t: any) => t.category === b.category);
             const spent = catExpenses.reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0);
             totalSpent += spent;
             
             const limit = Number(b.limit) || 0;
             const ratio = limit > 0 ? spent / limit : 0;
             const percentage = Math.round(ratio * 100);
             const status = ratio >= 1.0 ? 'exceeded' : ratio >= 0.8 ? 'warning' : 'safe';
             
             return { ...b, spent, remaining: Math.max(0, limit - spent), percentage, status };
          });
          budData.totalBudget = totalBudget;
          budData.totalSpent = totalSpent;
          
          finalBudData = budData;
          await idbSet('lkgs_budgets', finalBudData);
        } else {
          await idbSet('lkgs_budgets', budData);
        }
        
        setBudgetsData(finalBudData);

        const comRes = await fetch('/api/commitments', { headers });
        const comData = await comRes.json();
        let finalCom = [];
        if (comRes.ok && comData && comData.commitments && !comData.partial) {
          let cachedCom = (await idbGet<any[]>('lkgs_commitments')) || [];
          if (!Array.isArray(cachedCom)) cachedCom = [];
          const unsyncedCom = cachedCom.filter(c => c._unsynced);
          if (unsyncedCom.length > 0) {
            await fetch('/api/sync', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ commitments: unsyncedCom }) });
            const newRes = await fetch('/api/commitments', { headers });
            const newData = await newRes.json();
            finalCom = newData.commitments || [];
          } else {
            finalCom = comData.commitments;
          }
          await idbSet('lkgs_commitments', finalCom);
        } else {
          let cachedCom = (await idbGet<any[]>('lkgs_commitments')) || [];
          if (!Array.isArray(cachedCom)) cachedCom = [];
          const pending = (comData && comData.partial && comData.commitments) ? comData.commitments : [];
          const merged = new Map(cachedCom.map(c => [c.id, c]));
          pending.forEach(p => merged.set(p.id, { ...p, _unsynced: true }));
          finalCom = Array.from(merged.values()).filter(c => !c.deleted).sort((a, b) => new Date(a.dueDate || 0).getTime() - new Date(b.dueDate || 0).getTime());
        }
        setCommitments(finalCom);

        const savingsRes = await fetch('/api/savings-goals', { headers });
        const savingsData = await savingsRes.json().catch(() => ({}));
        let finalSavings = [];
        if (savingsRes.ok && savingsData && Array.isArray(savingsData.goals) && !savingsData.partial) {
          finalSavings = savingsData.goals;
          await idbSet('lkgs_savings_goals', finalSavings);
        } else {
          const cachedSavings = (await idbGet<any[]>('lkgs_savings_goals')) || [];
          finalSavings = Array.isArray(cachedSavings) ? cachedSavings : [];
        }
        setSavingsGoals(finalSavings);

        const memRes = await fetch('/api/memory', { headers });
        const memData = await memRes.json();
        if (memData && memData.memory) {
          setUserMemory(memData.memory);
        }
      } catch (err) {
        console.error("Failed to fetch data", err);
      }
    };
    
    fetchData();
    
    const handleRefresh = () => fetchData();
    const handleInterrupted = () => {
      setInterruptedFeedback(true);
      setTimeout(() => setInterruptedFeedback(false), 2500);
    };

    window.addEventListener('masrofi:refresh', handleRefresh);
    window.addEventListener('masrofi:user-interrupted', handleInterrupted);
    return () => {
      
      window.removeEventListener('masrofi:refresh', handleRefresh);
      window.removeEventListener('masrofi:user-interrupted', handleInterrupted);
    };
  }, [idToken]);

  const handleSaveMemoryItem = async (e: FormEvent) => {
    e.preventDefault();
    if (!idToken || !newMemoryKey.trim() || !newMemoryValue.trim()) return;
    setIsMemoryLoading(true);
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
        body: JSON.stringify({ key: newMemoryKey.trim(), value: newMemoryValue.trim() })
      });
      const data = await res.json();
      if (data.success) {
        setUserMemory(prev => ({ ...prev, [newMemoryKey.trim()]: newMemoryValue.trim() }));
        setNewMemoryKey('');
        setNewMemoryValue('');
      }
    } catch (err) {
      console.error("Failed to save memory item", err);
    } finally {
      setIsMemoryLoading(false);
    }
  };

  const handleDeleteMemoryItem = async (key: string) => {
    if (!idToken) return;
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      const data = await res.json();
      if (data.success) {
        setUserMemory(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    } catch (err) {
      console.error("Failed to delete memory item", err);
    }
  };

  const exportWord = () => {
    const rawTransactions = activeReport ? activeReport.transactions : transactions;
    const reportData = buildHierarchicalReport(rawTransactions);
    const title = activeReport ? activeReport.title : 'التقرير المالي الهيكلي الشامل';
    const dateStr = activeReport 
      ? new Date(activeReport.date).toLocaleDateString('ar-EG') 
      : new Date().toLocaleDateString('ar-EG');

    const wordHtml = buildWordDocumentContent(title, dateStr, userName, reportData);
    const blob = new Blob(['\ufeff', wordHtml], { type: 'application/msword;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const fileDownload = document.createElement("a");
    document.body.appendChild(fileDownload);
    fileDownload.href = url;
    fileDownload.download = `${title.replace(/\s+/g, '_')}.doc`;
    fileDownload.click();
    document.body.removeChild(fileDownload);
    URL.revokeObjectURL(url);
  };

  const handleGenerateInstantReport = async (timeframe: string = 'all', categoryName?: string) => {
    if (!idToken) return;
    try {
      const res = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          timeframe,
          category: categoryName,
          title: categoryName 
            ? `تقرير تفصيلي لبند (${categoryName})` 
            : timeframe === 'month' 
            ? 'التقرير المالي الشهري الشامل' 
            : timeframe === 'today'
            ? 'تقرير مصروفات اليوم التفصيلي'
            : 'التقرير المالي الهيكلي الشامل لكافة البنود'
        })
      });
      const data = await res.json();
      if (data.success) {
        window.dispatchEvent(new CustomEvent('masrofi:refresh'));
      }
    } catch (e) {
      console.error("Instant report generation error", e);
    }
  };

  const printReport = () => {
    window.print();
  };

  const handleScanReceipt = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;
    if (file.size > 8 * 1024 * 1024) {
      alert('حجم الملف كبير. استخدم صورة/ملف أقل من 8MB أو قسم الجدول إلى أكثر من ملف.');
      e.target.value = '';
      return;
    }
    
    setIsScanning(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        let currentToken = idToken;
        try {
          if (user && typeof user.getIdToken === 'function') {
            currentToken = await user.getIdToken(true);
            setIdToken(currentToken);
          }
        } catch(e){}
        const base64 = (reader.result as string).split(',')[1];
        const res = await fetch('/api/scan-receipt', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${currentToken}`
          },
          body: JSON.stringify({
            fileBase64: base64,
            imageBase64: file.type.startsWith('image/') ? base64 : undefined,
            mimeType: file.type || 'application/octet-stream',
            fileName: file.name,
            apiKey
          })
        });
        const data = await res.json();
        if (data.success) {
          setShowScannerResult(data);
          if (!data.requiresConfirmation) {
            window.dispatchEvent(new CustomEvent('masrofi:refresh'));
          }
        } else {
          alert("فشل في تحليل الملف: " + (data.message || data.error || "خطأ غير معروف"));
        }
      } catch (err) {
        console.error("Scan error", err);
        alert("حدث خطأ أثناء تحليل ملف المصروفات");
      } finally {
        setIsScanning(false);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // Reset
  };

  const handleRecordScannedReceipt = async (paymentMethod: 'cash' | 'palPay' | 'debt') => {
    if (!idToken || !showScannerResult || isRecordingScannedReceipt) return;
    const missingDateCount = (showScannerResult.items || []).filter((item: any) => !isCompleteScannedReceiptDate(item?.date)).length;
    if (missingDateCount > 0) {
      alert(`يوجد ${missingDateCount} بند بدون تاريخ. ضع تاريخاً للبنود الناقصة أو اضغط "طبّق على البنود الناقصة" قبل التسجيل.`);
      return;
    }
    setIsRecordingScannedReceipt(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch('/api/scan-receipt/record', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          paymentMethod,
          merchant: showScannerResult.merchant,
          sourceType: showScannerResult.sourceType,
          currentBalances: { cash, palPay, debt, total: balance },
          splitOverflowToDebt: true,
          items: showScannerResult.items || []
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        alert(data?.message || data?.error || 'تعذر تسجيل الفاتورة. قد تحتاج تأكيداً مالياً أو اختيار طريقة دفع أخرى.');
        return;
      }
      await rememberCloudConnected();
      setShowScannerResult(null);
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (err: any) {
      console.error('Record scanned receipt error', err);
      alert(err?.name === 'AbortError'
        ? 'تأخر تسجيل الفاتورة أكثر من 30 ثانية. أوقفت الطلب حتى لا يبقى عالقاً. جرّب مرة واحدة بعد قليل.'
        : 'حدث خطأ أثناء تسجيل الفاتورة.');
    } finally {
      window.clearTimeout(timeout);
      setIsRecordingScannedReceipt(false);
    }
  };

  const handleSaveBudgetLimit = async (category: string, limit: number) => {
    if (!idToken) return;
    try {
      const res = await fetch('/api/budgets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ category, limit })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.error || data?.message || 'تعذر حفظ سقف الموازنة');
      setEditingBudgetCat(null);
      setEditingBudgetLimit('');
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (e) {
      console.error("Failed to save budget limit", e);
    }
  };

  const handleCreateSavingsGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken || !newSavingsName.trim() || !newSavingsTarget) return;
    setIsSavingsSaving(true);
    try {
      const res = await fetch('/api/savings-goals', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newSavingsName.trim(),
          targetAmount: Number(newSavingsTarget),
          durationMonths: Number(newSavingsDurationMonths) || 12,
          priority: 'high',
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.message || data?.error || 'تعذر إنشاء هدف الادخار');
      setNewSavingsName('');
      setNewSavingsTarget('');
      setNewSavingsDurationMonths('12');
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (err) {
      console.error('Failed to create savings goal', err);
    } finally {
      setIsSavingsSaving(false);
    }
  };

  const handleAddSavingsContribution = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken || !savingsContributionAmount) return;
    setIsSavingsSaving(true);
    try {
      const activeGoals = savingsGoals.filter((g: any) => String(g.status || 'active') !== 'completed');
      const goalId = savingsContributionGoalId || (activeGoals.length === 1 ? activeGoals[0].id : '');
      if (!goalId) {
        alert(activeGoals.length > 1 ? 'اختر هدف الادخار أولاً.' : 'أنشئ هدف ادخار قبل إضافة مساهمة.');
        return;
      }
      const res = await fetch(`/api/savings-goals/${encodeURIComponent(goalId)}/contribute`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(savingsContributionAmount) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.message || data?.error || 'تعذر إضافة الادخار');
      setSavingsContributionAmount('');
      setSavingsContributionGoalId('');
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (err) {
      console.error('Failed to add savings contribution', err);
    } finally {
      setIsSavingsSaving(false);
    }
  };

  const handleCreateCommitment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!idToken || !newCommitmentTitle || !newCommitmentAmount || !newCommitmentDate) return;
    try {
      const res = await fetch('/api/commitments', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: newCommitmentTitle,
          amount: Number(newCommitmentAmount),
          dueDate: newCommitmentDate,
          category: newCommitmentCategory
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.error || data?.message || 'تعذر إنشاء الالتزام');
      setNewCommitmentTitle('');
      setNewCommitmentAmount('');
      setNewCommitmentDate('');
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (e) {
      console.error("Failed to add commitment", e);
    }
  };

  const handleDeleteCommitment = async (id: string) => {
    if (!idToken) return;
    try {
      const res = await fetch(`/api/commitments/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.error || data?.message || 'تعذر حذف الالتزام');
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (e) {
      console.error("Failed to delete commitment", e);
    }
  };

  const handleShareWhatsApp = () => {
    const rawTransactions = getReportTransactions(activeReport, transactions);
    const reportData = buildHierarchicalReport(rawTransactions);
    const title = activeReport ? activeReport.title : 'التقرير المالي الهيكلي الشامل';
    const dateStr = activeReport ? new Date(activeReport.date || activeReport.createdAt).toLocaleDateString('ar-EG') : new Date().toLocaleDateString('ar-EG');
    const text = buildWhatsAppReportText(title, dateStr, userName, reportData);
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(waUrl, '_blank');
  };

  const handleShareEmail = () => {
    const rawTransactions = getReportTransactions(activeReport, transactions);
    const reportData = buildHierarchicalReport(rawTransactions);
    const title = activeReport ? activeReport.title : 'التقرير المالي الهيكلي الشامل';
    const dateStr = activeReport ? new Date(activeReport.date || activeReport.createdAt).toLocaleDateString('ar-EG') : new Date().toLocaleDateString('ar-EG');
    const text = buildWhatsAppReportText(title, dateStr, userName, reportData);
    const mailUrl = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
    window.open(mailUrl, '_blank');
  };

  const handleCopyReport = () => {
    const rawTransactions = getReportTransactions(activeReport, transactions);
    const reportData = buildHierarchicalReport(rawTransactions);
    const title = activeReport ? activeReport.title : 'التقرير المالي الهيكلي الشامل';
    const dateStr = activeReport ? new Date(activeReport.date || activeReport.createdAt).toLocaleDateString('ar-EG') : new Date().toLocaleDateString('ar-EG');
    const text = buildWhatsAppReportText(title, dateStr, userName, reportData);
    navigator.clipboard.writeText(text);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 3000);
  };

  const handleDeleteReport = async (reportId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!idToken) return;
    try {
      const res = await fetch(`/api/reports/${reportId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.message || data?.error || 'تعذر حذف التقرير');
      setReportsList(prev => prev.filter(r => r.id !== reportId));
      if (activeReport?.id === reportId) {
        setShowReports(false);
        setActiveReport(null);
      }
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (err) {
      console.error("Failed to delete report", err);
    }
  };

  const handleClearAllReports = async () => {
    if (!idToken || reportsList.length === 0) return;
    if (!window.confirm("هل أنت متأكد من رغبتك في حذف جميع التقارير المحفوظة لتفريغ الحافظة ومنع تكدسها؟")) return;
    try {
      const res = await fetch('/api/reports', {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) throw new Error(data?.message || data?.error || 'تعذر حذف التقارير');
      setReportsList([]);
      setShowReports(false);
      setActiveReport(null);
      window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    } catch (err) {
      console.error("Failed to clear reports", err);
    }
  };

  const handleMicClick = async () => {
    if (isConnected) {
      disconnect();
    } else {
      let currentToken = idToken;
      if (user && typeof user.getIdToken === 'function') {
        try {
          currentToken = await user.getIdToken(true);
          setIdToken(currentToken);
        } catch (e) {
          console.warn("Failed to refresh token", e);
        }
      }
      connect(currentToken || undefined);
    }
  };

  const normalizeLocalArabic = (value: string) => String(value || '')
    .toLowerCase()
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const extractAmountFromText = (text: string): number | null => {
    const normalized = normalizeLocalArabic(text);
    const match = normalized.match(/(?:^|\s)(\d+(?:[\.,]\d+)?)(?=\s*(?:ش|شيكل|₪|دينار|دولار|$|\s|$))/);
    if (!match) return null;
    const amount = Number(String(match[1]).replace(',', '.'));
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  };

  const normalizeOfflineAccount = (text: string): 'cash' | 'palPay' | 'debt' | null => {
    const t = normalizeLocalArabic(text);
    if (t.includes('بال باي') || t.includes('palpay') || t.includes('pal pay') || t.includes('محفظ')) return 'palPay';
    if (t.includes('دين') || t.includes('بالدين')) return 'debt';
    if (t.includes('كاش') || t.includes('نقد')) return 'cash';
    return null;
  };

  const inferOfflineCategory = (text: string): { category: string; subcategory: string; purchaseItem: string } => {
    const t = normalizeLocalArabic(text);
    if (/اولاد|الاولاد|عيال|ابن|بنت|اطفال|اطفال/.test(t)) return { category: 'الأبناء', subcategory: 'مصروف', purchaseItem: 'احتياجات الأبناء' };
    if (/تموين|بقال|خبز|طحين|رز|سكر|زيت|خضار|فواكه|بطاطا|ماء|مياه|غاز/.test(t)) return { category: 'طعام ومشتريات منزل', subcategory: 'تموين', purchaseItem: 'تموين ومشتريات منزل' };
    if (/دواء|صيدليه|صيدلية|دكتور|طبيب|علاج|تحاليل/.test(t)) return { category: 'صحة وعلاج', subcategory: 'علاج', purchaseItem: 'علاج/دواء' };
    if (/ملابس|لبس|اواعي|حذاء|كندره|جزمه/.test(t)) return { category: 'الأبناء', subcategory: 'ملابس', purchaseItem: 'ملابس/أحذية' };
    if (/مواصلات|تاكسي|اجره|بنزين|سولار/.test(t)) return { category: 'مواصلات', subcategory: 'مواصلات', purchaseItem: 'مواصلات' };
    return { category: 'أخرى', subcategory: 'متفرقات', purchaseItem: '' };
  };

  const extractMerchantFromPurchase = (text: string): string => {
    const raw = String(text || '').trim();
    const match = raw.match(/(?:من\s+(?:عند\s+)?|عند\s+)([^\d،,.]+?)(?=\s+(?:ب|بـ|بمبلغ|بقيمة|ل|لل|لاجل|عشان|دين|كاش|بال|على)|$)/i);
    return match?.[1]?.trim() || '';
  };

  const extractBeneficiary = (text: string): string => {
    const raw = String(text || '').trim();
    const match = raw.match(/(?:لل|لـ|ل)([\p{L}\s]+?)(?=$|\s+(?:من|عند|ب|بـ|دين|كاش|بال|على|و))/u);
    return match?.[1]?.trim() || '';
  };

  const buildOfflineFinancialCommand = (text: string, clientMessageId: string): { commandType: FinancialCommandType; args: any; operationId: string; summary: string } | { error: string } => {
    const amount = extractAmountFromText(text);
    const normalized = normalizeLocalArabic(text);
    const account = normalizeOfflineAccount(text);
    const isPurchase = /اشتريت|شريت|اخذت|اخدت|شراء/.test(normalized);
    const isIncome = /دخل|راتب|مساعده|مساعدة|هديه|هدية|استلمت|وصلني/.test(normalized) && !isPurchase;
    const isCashBorrowing = /دين نقدي|سلفني|سلفه|سلفة|استدنت|اقترضت/.test(normalized);

    if (!amount) return { error: 'وأنت أوفلاين لازم تذكر المبلغ صراحة حتى أحفظها للمزامنة.' };

    if (isCashBorrowing) {
      const creditor = extractMerchantFromPurchase(text) || 'غير محدد';
      const args = { amount, fromAccount: 'debt', toAccount: 'cash', creditor, notes: text };
      return {
        commandType: 'TRANSFER_MONEY',
        args,
        operationId: `offline:${clientMessageId}:borrow-cash:${amount}:${normalizeLocalArabic(creditor)}`,
        summary: `حفظت أمر استدانة نقدية ${amount} ₪ للمزامنة عند رجوع السحابة.`
      };
    }

    if (isIncome) {
      if (!account || account === 'debt') return { error: 'الدخل أوفلاين يحتاج تحديد واضح: كاش أم PalPay؟' };
      const args = {
        amount,
        type: 'income',
        paymentMethod: account,
        account,
        category: normalized.includes('راتب') ? 'دخل' : 'دخل',
        subcategory: normalized.includes('راتب') ? 'راتب' : 'دخل عام',
        notes: text,
        // Preserve the user's original words so the server remains the authority
        // for income nature/destination confirmation. Offline parsing may extract
        // candidates, but it must never manufacture a business confirmation.
        userText: text,
      };
      return {
        commandType: 'ADD_TRANSACTION',
        args,
        operationId: `offline:${clientMessageId}:income:${account}:${amount}:${normalizeLocalArabic(args.subcategory)}`,
        summary: `حفظت أمر دخل ${amount} ₪ على ${account === 'palPay' ? 'PalPay' : 'كاش'} للمزامنة عند رجوع السحابة.`
      };
    }

    if (isPurchase) {
      if (!account) return { error: 'الشراء أوفلاين يحتاج طريقة دفع واضحة: كاش، PalPay، أو دين.' };
      const merchant = extractMerchantFromPurchase(text);
      const beneficiary = extractBeneficiary(text);
      const inferred = inferOfflineCategory(text);
      const purchaseItem = inferred.purchaseItem || beneficiary || text;
      if (account === 'debt' && !merchant) return { error: 'شراء الدين أوفلاين يحتاج اسم الدائن أو المحل.' };
      if (account === 'debt' && !beneficiary && !inferred.purchaseItem && !/ل|لل|اولاد|زوجتي|البيت|تموين|علاج|دواء|ملابس|كندره|كندرة|خبز|غاز|ماء/.test(normalized)) {
        return { error: 'شراء الدين أوفلاين يحتاج توضيح: شو اشتريت أو لمين/لأي غرض؟' };
      }
      const args = {
        amount,
        type: 'expense',
        paymentMethod: account,
        account,
        category: inferred.category,
        subcategory: inferred.subcategory,
        purchaseItem,
        beneficiary,
        merchant,
        notes: text,
      };
      return {
        commandType: 'ADD_TRANSACTION',
        args,
        operationId: `offline:${clientMessageId}:expense:${account}:${amount}:${normalizeLocalArabic(merchant)}:${normalizeLocalArabic(purchaseItem)}:${normalizeLocalArabic(beneficiary)}`,
        summary: `حفظت أمر شراء ${amount} ₪ ${account === 'debt' ? 'دين' : account === 'palPay' ? 'PalPay' : 'كاش'} للمزامنة عند رجوع السحابة.`
      };
    }

    return { error: 'وأنت أوفلاين أقدر أحفظ أوامر واضحة مثل: اشتريت ... بـ ... كاش/دين، أو دخل ... كاش/PalPay.' };
  };

  const queueOfflineFinancialCommand = async (text: string, clientMessageId: string): Promise<boolean> => {
    if (!user?.uid) return false;
    const command = buildOfflineFinancialCommand(text, clientMessageId);
    if ('error' in command) {
      setChatMessages(prev => [...prev, { role: 'ai', text: command.error }]);
      return true;
    }
    await enqueuePendingOp(user.uid, command.commandType, command.args, command.operationId);
    const pending = await getPendingCount(user.uid).catch(() => 0);
    setChatMessages(prev => [...prev, { role: 'ai', text: `${command.summary}\nسيتم إرسالها للسحابة عبر /api/command عند عودة الاتصال. العمليات المعلقة الآن: ${pending}.` }]);
    window.dispatchEvent(new CustomEvent('masrofi:refresh'));
    return true;
  };

  const handleChatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !user || isChatLoading) return;
    
    const text = chatInput.trim();
    const clientMessageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text }]);
    setIsChatLoading(true);

    try {
      if (isOfflineMode) {
        await queueOfflineFinancialCommand(text, clientMessageId);
        return;
      }

      let currentToken = idToken;
      try {
        if (user && typeof user.getIdToken === 'function') {
          currentToken = await user.getIdToken(true);
          setIdToken(currentToken);
        }
      } catch(e){}
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentToken}`
        },
        body: JSON.stringify({ message: text, clientMessageId, history: chatMessages, userName, aiName, relationship: aiRelationship, persona, apiKey })
      });
      const data = await res.json();
      
      if (data.success && data.text) {
        setChatMessages(prev => [...prev, { role: 'ai', text: data.text }]);
        if (Array.isArray(data.committedTransactions) && data.committedTransactions.length > 0) {
          void rememberCloudConnected();
          setTransactions(prev => {
            const byId = new Map((Array.isArray(prev) ? prev : []).map((t: any) => [t.id, t]));
            for (const tx of data.committedTransactions) {
              if (tx?.id) byId.set(tx.id, tx);
            }
            const merged = Array.from(byId.values()).filter((t: any) => !t.deleted);
            idbSet('lkgs_transactions', merged).catch(() => {});
            return merged.sort((a: any, b: any) => String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || '')));
          });
        }
        window.dispatchEvent(new CustomEvent('masrofi:refresh'));
      } else {
        if (!res.ok) {
          const queued = await queueOfflineFinancialCommand(text, clientMessageId);
          if (!queued) setChatMessages(prev => [...prev, { role: 'ai', text: 'عذراً، حدث خطأ في النظام.' }]);
        } else {
          setChatMessages(prev => [...prev, { role: 'ai', text: 'عذراً، حدث خطأ في النظام.' }]);
        }
      }
    } catch (err) {
      const queued = await queueOfflineFinancialCommand(text, clientMessageId);
      if (!queued) {
        setChatMessages(prev => [...prev, { role: 'ai', text: 'عذراً، لم أتمكن من الاتصال بالخادم.' }]);
      }
    } finally {
      setIsChatLoading(false);
    }
  };

  const getStatusDisplay = () => {
    if (error) return <span className="flex items-center gap-2 text-rose-400 bg-rose-500/10 border border-rose-500/20 px-4 py-2 rounded-full"><AlertCircle className="w-4 h-4" /> {error}</span>;
    if (!isConnected) return <span className="flex items-center gap-2 text-slate-300 bg-slate-800 border border-slate-700 px-4 py-2 rounded-full">جاهز للمساعدة</span>;
    if (interruptedFeedback) return <span className="flex items-center gap-2 text-emerald-300 bg-emerald-500/20 border border-emerald-500/30 px-4 py-2 rounded-full shadow-[0_0_12px_rgba(16,185,129,0.3)] animate-pulse font-medium"><Mic className="w-4 h-4 text-emerald-400" /> أنا باسمعك... تفضل 👂</span>;

    switch (status) {
      case 'listening':
        return <span className="flex items-center gap-2 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-full shadow-[0_0_10px_rgba(16,185,129,0.2)] animate-pulse"><Mic className="w-4 h-4" /> أسمعك بوضوح...</span>;
      case 'thinking':
        return <span className="flex items-center gap-2 text-amber-400 bg-amber-500/10 border border-amber-500/20 px-4 py-2 rounded-full shadow-[0_0_10px_rgba(251,191,36,0.2)] animate-pulse"><Loader2 className="w-4 h-4 animate-spin" /> أفكر...</span>;
      case 'talking':
        return <span className="flex items-center gap-2 text-blue-400 bg-blue-500/10 border border-blue-500/20 px-4 py-2 rounded-full shadow-[0_0_10px_rgba(59,130,246,0.2)] animate-pulse"><Volume2 className="w-4 h-4" /> أتحدث...</span>;
      default:
        return <span className="flex items-center gap-2 text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-full"><Volume2 className="w-4 h-4" /> متصل</span>;
    }
  };

  // V6 (MF-7): MONTHLY stats (not all-time). The variable names said "month" but the code
  // previously summed ALL transactions. Now we correctly filter to current month.
  const currentMonthPrefix = new Date().toISOString().slice(0, 7);
  const isThisMonth = (t: any) => {
    const d = String(t.date || t.createdAt || '');
    return d.startsWith(currentMonthPrefix);
  };
  // Also exclude transfers so they don't pollute expense/income totals.
  const isNotTransfer = (t: any) => t.type !== 'transfer' && t.category !== 'تحويل' && t.category !== 'تحويل داخلي';

  const monthExpense = transactions
    .filter(t => t.type === 'expense' && isNotTransfer(t) && isThisMonth(t))
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  const monthIncome = transactions
    .filter(t => t.type === 'income' && isNotTransfer(t) && isThisMonth(t))
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  const necessityTotal = transactions
    .filter(t => t.type === 'expense' && isNotTransfer(t) && isThisMonth(t) && (t.necessity === 'ضروري' || !t.necessity))
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  const luxuryTotal = transactions
    .filter(t => t.type === 'expense' && isNotTransfer(t) && isThisMonth(t) && t.necessity === 'كمالي')
    .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  // Calculate comprehensive Financial Fitness Score (0-100)
  const fitness = calculateFinancialFitness(monthIncome, monthExpense, Math.max(0, debt), necessityTotal, luxuryTotal, transactions.length);

  // Check budget warnings
  const hasBudgetWarnings = (budgetsData.budgets || []).some((b: any) => b.status === 'warning' || b.status === 'exceeded');
  const dueSoonCommitmentsCount = commitments.filter(c => c.isDueSoon || c.isOverdue).length;
  const activeSavingsGoals = savingsGoals.filter((g: any) => String(g.status || 'active') !== 'completed');
  const criticalSavingsGoals = activeSavingsGoals.filter((g: any) => g.alertLevel === 'critical');
  const warningSavingsGoals = activeSavingsGoals.filter((g: any) => g.alertLevel === 'warning');
  const savingsTargetTotal = activeSavingsGoals.reduce((sum: number, g: any) => sum + (Number(g.targetAmount) || 0), 0);
  const savingsSavedTotal = activeSavingsGoals.reduce((sum: number, g: any) => sum + (Number(g.savedAmount) || 0), 0);
  const savingsProgress = savingsTargetTotal > 0 ? Math.min(100, Math.round((savingsSavedTotal / savingsTargetTotal) * 100)) : 0;
  const savingsMonthlyRequired = activeSavingsGoals.reduce((sum: number, g: any) => sum + (Number(g.monthlyRequired) || 0), 0);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-emerald-400">
        <Loader2 className="w-10 h-10 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div dir="rtl" className="min-h-screen bg-slate-950 font-sans text-slate-50 flex items-center justify-center p-4 selection:bg-emerald-500/30">
        <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 sm:p-8 shadow-2xl text-center">
          <div className="w-16 h-16 bg-emerald-500/20 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-inner border border-emerald-500/30">
            <PiggyBank className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1">مصروفي <span className="text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]">AI</span></h1>
          <p className="text-slate-400 mb-6 text-xs sm:text-sm">مديرك المالي الذكي. سجّل دخولك للوصول إلى كافة بياناتك ومعاملاتك المحفوظة.</p>

          {loginError && (
            <div className="mb-5 p-3.5 bg-rose-500/10 border border-rose-500/30 rounded-2xl text-rose-300 text-xs text-right leading-relaxed flex items-start gap-2 animate-in fade-in duration-200">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold mb-0.5">تنبيه:</p>
                <p>{loginError}</p>
              </div>
            </div>
          )}

          {/* Quick 1-Tap Login for Safari & Mobile */}
          <div className="space-y-4 text-right">
            <div className="p-4 bg-emerald-950/40 border border-emerald-500/30 rounded-2xl">
              <div className="flex items-center gap-2 mb-2 text-emerald-400 text-xs font-bold">
                <Sparkles className="w-4 h-4" />
                <span>الدخول الفوري السريع (موصى به لمتصفح سفاري وiOS):</span>
              </div>
              <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                يتجاوز قيود النوافذ المنبثقة وملفات الارتباط في سفاري فوراً:
              </p>
              <button
                type="button"
                onClick={() => authEmail.trim() && handleSafariDirectLogin(authEmail)}
                disabled={isLoggingIn || !authEmail.trim()}
                className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white py-3.5 px-4 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-emerald-900/30 active:scale-[0.98]"
              >
                {isLoggingIn ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>جاري تسجيل الدخول واسترجاع البيانات...</span>
                  </>
                ) : (
                  <>
                    <LogIn className="w-4 h-4" />
                    <span>دخول فوري بالبريد الإلكتروني</span>
                  </>
                )}
              </button>
            </div>

            {/* Custom Email Form */}
            <div className="pt-2">
              <label className="block text-xs font-medium text-slate-400 mb-1.5">أو الدخول ببريد إلكتروني آخر:</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Mail className="w-4 h-4 text-slate-500 absolute right-3 top-3" />
                  <input
                    type="email"
                    dir="ltr"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="your-email@example.com"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl pr-9 pl-3 py-2 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 transition-colors text-right"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => handleSafariDirectLogin(authEmail)}
                  disabled={isLoggingIn || !authEmail}
                  className="bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-emerald-400 px-4 py-2 rounded-xl text-xs font-semibold border border-slate-700 transition-colors shrink-0"
                >
                  دخول
                </button>
              </div>
            </div>

            {/* Google Popup button */}
            <div className="pt-3 border-t border-slate-800/80">
              <button 
                type="button"
                onClick={handleGoogleLogin} 
                disabled={isLoggingIn}
                className="w-full bg-white/10 hover:bg-white/15 text-slate-200 py-2.5 px-4 rounded-xl font-medium text-xs flex items-center justify-center gap-2.5 transition-all border border-white/10 active:scale-[0.98] disabled:opacity-50"
              >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                </svg>
                <span>الدخول عبر نافذة Google المنبثقة</span>
              </button>
            </div>
          </div>

          {/* V6 (LF-16): developer PII removed from production login page. */}

          <div className="mt-4 text-[11px] text-slate-500 flex items-center justify-center gap-1.5">
            <KeyRound className="w-3.5 h-3.5 text-emerald-500" />
            <span>بياناتك المالية آمنة على السحابة. كل مستخدم معزول تماماً.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div dir="rtl" className="min-h-screen bg-slate-950 font-sans text-slate-50 pb-32 selection:bg-emerald-500/30">
      {/* Header */}
      <header className="bg-slate-900/50 backdrop-blur-md border-b border-white/5 px-4 sm:px-6 py-3 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto flex flex-col gap-3 sm:gap-0 sm:flex-row sm:items-center justify-between">
          
          {/* Top Row (Mobile) / Left Side (Desktop): Logo & Status/User Info */}
          <div className="flex items-center justify-between w-full sm:w-auto">
            <div className="flex items-center gap-3">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">مصروفي <span className="text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]">AI</span></h1>
              <div className={`hidden lg:block text-[10px] sm:text-xs px-2.5 py-1 rounded-full border font-medium ${isOfflineMode ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'}`}>
                {isOfflineMode ? '📱 تخزين محلي (غير متصل)' : '☁️ متصل سحابياً'}
              </div>
            </div>
            
            {/* Mobile Only Status & User Info */}
            <div className="flex flex-col items-end gap-1 sm:hidden">
              <div className="flex items-center gap-1.5 text-[11px] text-slate-300">
                <span className={`w-1.5 h-1.5 rounded-full ${isOfflineMode ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
                <span className="truncate max-w-[130px] font-medium">{user.email}</span>
              </div>
              <div className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium ${isOfflineMode ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'}`}>
                {isOfflineMode ? '📱 محلي' : '☁️ متصل'}
              </div>
            </div>
          </div>

          {/* Actions Row */}
          <div className="flex gap-2 sm:gap-3 items-center justify-between sm:justify-end w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0 scrollbar-hide">
            <div className={`hidden sm:flex lg:hidden text-[10px] sm:text-xs px-2.5 py-1 rounded-full border font-medium ${isOfflineMode ? 'bg-amber-500/10 text-amber-400 border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'}`}>
              {isOfflineMode ? '📱 غير متصل' : '☁️ متصل'}
            </div>
            <div className="hidden sm:flex items-center gap-2 text-sm text-slate-400 border-l border-slate-800 pl-4 ml-2">
              <span className={`w-2 h-2 rounded-full ${isOfflineMode ? 'bg-amber-400' : 'bg-emerald-400'}`}></span>
              {user.email}
            </div>

            {/* Smart Budgets Quick Button */}
            <button 
              onClick={() => setShowBudgets(true)} 
              className={`p-2.5 rounded-2xl border transition-all relative flex items-center gap-1.5 text-xs font-semibold ${
                hasBudgetWarnings 
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 animate-pulse' 
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border-slate-700'
              }`} 
              title="نظام الموازنات والتنبيه المسبق"
            >
              <Target className="w-4 h-4 text-amber-400" />
              <span className="hidden sm:inline">الموازنات</span>
              {hasBudgetWarnings && (
                <span className="w-2 h-2 bg-amber-400 rounded-full absolute -top-1 -right-1"></span>
              )}
            </button>

            {/* Savings Goals Quick Button */}
            <button 
              onClick={() => setShowSavings(true)} 
              className={`p-2.5 rounded-2xl border transition-all relative flex items-center gap-1.5 text-xs font-semibold ${
                criticalSavingsGoals.length > 0
                  ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 animate-pulse'
                  : warningSavingsGoals.length > 0
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border-slate-700'
              }`} 
              title="المدخرات وأهداف الادخار"
            >
              <PiggyBank className="w-4 h-4 text-emerald-400" />
              <span className="hidden sm:inline">المدخرات</span>
              {criticalSavingsGoals.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 rounded-full text-[10px] flex items-center justify-center font-bold text-white animate-bounce">
                  {criticalSavingsGoals.length}
                </span>
              )}
            </button>

            {/* Commitments & Cash Flow Quick Button */}
            <button 
              onClick={() => setShowCommitments(true)} 
              className="p-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors relative flex items-center gap-1.5 text-xs font-semibold" 
              title="المساعد التنبؤي للرواتب والالتزامات"
            >
              <Calendar className="w-4 h-4 text-sky-400" />
              <span className="hidden sm:inline">الالتزامات</span>
              {dueSoonCommitmentsCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 rounded-full text-[10px] flex items-center justify-center font-bold text-white animate-bounce">
                  {dueSoonCommitmentsCount}
                </span>
              )}
            </button>

            <button onClick={() => setShowInbox(true)} className="bg-slate-800 p-2.5 rounded-2xl hover:bg-slate-700 border border-slate-700 transition-colors relative" title="حافظة المهام والتقارير">
              <FileText className="w-4 h-4 text-emerald-400" />
              {reportsList.length > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 rounded-full text-[10px] flex items-center justify-center font-bold">{reportsList.length}</span>
              )}
            </button>
            
            {/* Data Backup & Export/Import Quick Button */}
            <button 
              onClick={() => setShowDataBackup(true)} 
              className="bg-slate-800 p-2.5 rounded-2xl hover:bg-slate-700 border border-slate-700 transition-colors relative flex items-center gap-1 text-xs font-semibold text-slate-300" 
              title="إدارة ونسخ البيانات (استيراد وتصدير)"
            >
              <HardDrive className="w-4 h-4 text-emerald-400" />
              <span className="hidden lg:inline text-[11px]">نسخ واستيراد</span>
            </button>

            <button onClick={() => setShowSettings(true)} className="bg-slate-800 p-2.5 rounded-2xl hover:bg-slate-700 border border-slate-700 transition-colors" title="الإعدادات">
              <Settings className="w-4 h-4 text-slate-300" />
            </button>
            <button onClick={handleLogout} className="bg-rose-500/10 p-2.5 rounded-2xl hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 transition-colors active:scale-95 cursor-pointer" title="تسجيل الخروج">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Toast Notifications */}
      <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-full max-w-md px-4 pointer-events-none">
        {notifications.map(notif => {
          const isDanger = notif.type === 'danger' || notif.type === 'critical';
          return (
            <div key={notif.id} className={`shadow-2xl rounded-2xl p-4 flex items-center gap-3 animate-in slide-in-from-top-4 fade-in duration-300 pointer-events-auto border ${isDanger ? 'bg-rose-950 border-rose-500/50' : 'bg-slate-800 border-slate-700'}`}>
              <div className={`${isDanger ? 'bg-rose-500/20' : 'bg-emerald-500/20'} p-2 rounded-full shrink-0`}>
                {isDanger ? <ShieldAlert className="w-5 h-5 text-rose-300" /> : <CheckCircle className="w-5 h-5 text-emerald-400" />}
              </div>
              <p className={`text-sm font-medium ${isDanger ? 'text-rose-50' : 'text-white'}`}>{notif.message}</p>
            </div>
          );
        })}
      </div>

      <main className="max-w-7xl mx-auto px-6 mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Balance & Financial Fitness Card */}
        <div className="lg:col-span-4 space-y-6">
          <div className={`relative overflow-hidden rounded-3xl p-6 shadow-2xl border border-white/10 ${
            isConnected && status === 'listening' ? 'bg-gradient-to-br from-emerald-900 to-slate-900 shadow-[0_0_30px_rgba(16,185,129,0.15)]' : 'bg-slate-900'
          } transition-all duration-700`}>
            <div className="relative z-10">
              <div className="flex justify-between items-center mb-2">
                <p className="text-slate-400 text-sm font-medium">إجمالي الرصيد الفعلي</p>
                <div className={`text-xs font-bold px-2.5 py-1 rounded-full border border-white/10 bg-black/30 flex items-center gap-1.5 ${
                  fitness.score >= 80 ? 'text-emerald-400 border-emerald-500/30' : fitness.score >= 60 ? 'text-blue-400 border-blue-500/30' : 'text-amber-400 border-amber-500/30'
                }`}>
                  <Sparkles className="w-3 h-3" />
                  {fitness.grade} ({fitness.score}%)
                </div>
              </div>
              <h2 className="text-5xl font-bold mb-6 text-white tracking-tight">{balance} <span className="text-2xl font-normal text-slate-500">₪</span></h2>
              
              <div className="grid grid-cols-3 gap-2 border-t border-slate-800 pt-5">
                <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800">
                  <p className="text-slate-400 text-xs mb-1">نقدي</p>
                  <p className="font-semibold text-lg">{cash} ₪</p>
                </div>
                <div className="bg-slate-950/50 p-3 rounded-2xl border border-slate-800">
                  <p className="text-slate-400 text-xs mb-1">PalPay</p>
                  <p className="font-semibold text-lg">{palPay} ₪</p>
                </div>
                <div className={`p-3 rounded-2xl border ${debt < 0 ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-rose-500/10 border-rose-500/20'}`}>
                  <p className={`text-xs mb-1 ${debt < 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{debt < 0 ? 'فائض سداد (دائن)' : 'الديون'}</p>
                  <p className={`font-semibold text-lg ${debt < 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{Math.abs(debt)} ₪</p>
                </div>
              </div>
            </div>
            {/* Background elements */}
            <div className="absolute top-0 left-0 w-40 h-40 bg-emerald-500/10 rounded-full blur-3xl -translate-x-10 -translate-y-10"></div>
          </div>

          {/* Quick Expense & Income stats */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-900 p-5 rounded-3xl shadow-lg border border-slate-800 flex flex-col justify-center">
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-rose-500/20 p-2 rounded-xl">
                  <TrendingDown className="w-5 h-5 text-rose-400" />
                </div>
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">المصروف</p>
              </div>
              <p className="text-xl font-bold text-white">{monthExpense} ₪</p>
            </div>
            <div className="bg-slate-900 p-5 rounded-3xl shadow-lg border border-slate-800 flex flex-col justify-center">
              <div className="flex items-center gap-3 mb-2">
                <div className="bg-emerald-500/20 p-2 rounded-xl">
                  <TrendingUp className="w-5 h-5 text-emerald-400" />
                </div>
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wider">الدخل</p>
              </div>
              <p className="text-xl font-bold text-white">{monthIncome} ₪</p>
            </div>
          </div>

          {/* Savings Goals Card */}
          <div className={`border rounded-3xl p-5 shadow-xl ${criticalSavingsGoals.length > 0 ? 'bg-rose-950/30 border-rose-500/40' : 'bg-slate-900 border-slate-800'}`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <PiggyBank className="w-4 h-4 text-emerald-400" />
                المدخرات والأهداف
              </h3>
              <button onClick={() => setShowSavings(true)} className="text-[11px] text-emerald-300 hover:text-emerald-200 font-bold">
                إدارة
              </button>
            </div>

            {activeSavingsGoals.length > 0 ? (
              <div className="space-y-3">
                {criticalSavingsGoals[0] && (
                  <div className="bg-rose-500/15 border border-rose-500/40 rounded-2xl p-3 text-xs text-rose-100 flex items-start gap-2">
                    <ShieldAlert className="w-4 h-4 text-rose-300 shrink-0 mt-0.5" />
                    <span>{criticalSavingsGoals[0].alertMessage}</span>
                  </div>
                )}
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-400">التقدم الإجمالي</p>
                    <p className="text-2xl font-black text-white">{savingsSavedTotal.toLocaleString()} <span className="text-sm text-slate-500">₪</span></p>
                  </div>
                  <div className="text-left">
                    <p className="text-xs text-slate-400">المطلوب شهرياً</p>
                    <p className="text-lg font-black text-emerald-300">{Math.round(savingsMonthlyRequired).toLocaleString()} ₪</p>
                  </div>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden">
                  <div className="bg-emerald-500 h-2 rounded-full transition-all" style={{ width: `${savingsProgress}%` }}></div>
                </div>
                <div className="space-y-2">
                  {activeSavingsGoals.slice(0, 2).map((goal: any) => (
                    <button key={goal.id} onClick={() => setShowSavings(true)} className="w-full text-right bg-slate-950/60 border border-slate-800 hover:border-emerald-500/30 rounded-2xl p-3 transition-colors">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-sm font-bold text-white truncate">{goal.name}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${goal.alertLevel === 'critical' ? 'bg-rose-500/20 text-rose-300 border-rose-500/40' : goal.alertLevel === 'warning' ? 'bg-amber-500/20 text-amber-300 border-amber-500/40' : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'}`}>
                          {goal.progressPercentage || 0}%
                        </span>
                      </div>
                      <p className="text-[11px] text-slate-400">باقي {Number(goal.remainingAmount || 0).toLocaleString()} ₪ · شهرياً {Number(goal.monthlyRequired || 0).toLocaleString()} ₪</p>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-xs text-slate-400 mb-3">لا يوجد هدف ادخار. مثال: هدفي أوصل 5000 ₪ خلال سنة.</p>
                <button onClick={() => setShowSavings(true)} className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold">
                  + إنشاء هدف
                </button>
              </div>
            )}
          </div>

          {/* Comprehensive Financial Fitness Card (مؤشر الرشاقة المالية) */}
          <div className="bg-slate-900 border border-slate-800 rounded-3xl p-5 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-white text-sm flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-400" />
                مؤشر الرشاقة المالية (0-100)
              </h3>
              <span className={`text-xs font-black px-2.5 py-1 rounded-full ${fitness.badgeBg} ${fitness.color} border ${fitness.badgeBorder}`}>
                {fitness.grade} ({fitness.score}%)
              </span>
            </div>

            {/* Fitness Factors Progress Bars */}
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">معدل الادخار والاستدامة</span>
                  <span className="text-emerald-400 font-bold">{fitness.factors.savingsScore}/{fitness.factors.savingsMax}</span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: `${(fitness.factors.savingsScore / fitness.factors.savingsMax) * 100}%` }}></div>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">الأمان من عبء الديون</span>
                  <span className="text-sky-400 font-bold">{fitness.factors.debtScore}/{fitness.factors.debtMax}</span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-sky-500 h-1.5 rounded-full" style={{ width: `${(fitness.factors.debtScore / fitness.factors.debtMax) * 100}%` }}></div>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">ترشيد الضروريات والكماليات</span>
                  <span className="text-amber-400 font-bold">{fitness.factors.necessityScore}/{fitness.factors.necessityMax}</span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-amber-500 h-1.5 rounded-full" style={{ width: `${(fitness.factors.necessityScore / fitness.factors.necessityMax) * 100}%` }}></div>
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">الانضباط في التدوين</span>
                  <span className="text-purple-400 font-bold">{fitness.factors.disciplineScore}/{fitness.factors.disciplineMax}</span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-purple-500 h-1.5 rounded-full" style={{ width: `${(fitness.factors.disciplineScore / fitness.factors.disciplineMax) * 100}%` }}></div>
                </div>
              </div>
            </div>

            {/* Smart Tip */}
            {fitness.tips && fitness.tips.length > 0 && (
              <div className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-300 bg-slate-950/60 p-2.5 rounded-xl flex items-start gap-2">
                <span className="text-emerald-400 shrink-0 text-xs">💡</span>
                <p className="leading-relaxed">{fitness.tips[0]}</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Mind Map Chart */}
        <div className="lg:col-span-8">
          <div className="bg-slate-900 p-6 rounded-3xl shadow-2xl border border-slate-800 h-full min-h-[400px] flex flex-col relative overflow-hidden">
            <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
              خريطة العقل للمصروفات
            </h3>
            <p className="text-slate-400 text-sm mb-4">تحليل تفاعلي عصري لمسارات أموالك (تتحدث الخريطة تلقائياً مع الذكاء الاصطناعي).</p>
            
            <div className="flex-1 w-full relative z-10 bg-slate-950/50 rounded-2xl border border-slate-800/50 overflow-hidden">
              <MindMapChart transactions={transactions} />
            </div>
          </div>
        </div>

      </main>

      {/* Bottom Section: Recent Transactions */}
      <section className="max-w-7xl mx-auto px-6 mt-8 mb-24">
        <div className="bg-slate-900 p-6 rounded-3xl shadow-2xl border border-slate-800">
          <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
            <List className="w-5 h-5 text-emerald-400" />
            سجل العمليات الأخير
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-right">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 text-sm">
                  <th className="py-3 px-4 font-semibold w-32">التاريخ</th>
                  <th className="py-3 px-4 font-semibold">التصنيف</th>
                  <th className="py-3 px-4 font-semibold">المتجر / التفاصيل</th>
                  <th className="py-3 px-4 font-semibold text-left">المبلغ</th>
                </tr>
              </thead>
              <tbody>
                {transactions.slice(0, 10).map((tx, idx) => (
                  <tr key={tx.id || idx} className="border-b border-slate-800/50 hover:bg-slate-800/50 transition-colors">
                    <td className="py-4 px-4 text-sm text-slate-500">{new Date(tx.date || tx.createdAt).toLocaleDateString('ar-EG')}</td>
                    <td className="py-4 px-4">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${tx.type === 'expense' ? 'bg-rose-500' : tx.type === 'transfer' ? 'bg-sky-400' : 'bg-emerald-500'}`}></span>
                          <span className="text-slate-200 font-medium">
                            {tx.type === 'transfer' ? (
                              <span className="text-sky-300 font-medium">🔄 {tx.category || 'تحويل داخلي'} {tx.subcategory ? <span className="text-slate-400 text-xs mr-1">({tx.subcategory})</span> : ''}</span>
                            ) : (
                              <>{tx.category || '-'} {tx.subcategory ? <span className="text-slate-500 text-xs mr-1">&bull; {tx.subcategory}</span> : ''}</>
                            )}
                          </span>
                        </div>
                        {tx.necessity && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full w-fit ${tx.necessity === 'ضروري' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20' : 'bg-amber-500/20 text-amber-400 border border-amber-500/20'}`}>
                            {tx.necessity}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-4 px-4 text-sm text-slate-400">
                      {tx.type === 'transfer' ? (tx.notes || 'تحويل بين الحسابات') : (tx.merchant || tx.notes || '-')}
                      {tx.account === 'debt' && <span className="mr-2 text-rose-400 text-xs bg-rose-500/10 px-2 py-0.5 rounded-full border border-rose-500/20">دين</span>}
                      {tx.account === 'palPay' && tx.type !== 'transfer' && <span className="mr-2 text-sky-400 text-xs bg-sky-500/10 px-2 py-0.5 rounded-full border border-sky-500/20">PalPay</span>}
                    </td>
                    <td className={`py-4 px-4 text-sm font-bold text-left ${tx.type === 'expense' ? 'text-rose-400' : tx.type === 'transfer' ? 'text-sky-400' : 'text-emerald-400'}`}>
                      {tx.type === 'expense' ? '-' : tx.type === 'transfer' ? '↔ ' : '+'}{tx.amount} ₪
                    </td>
                  </tr>
                ))}
                {transactions.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 px-4 text-center">
                      <div className="flex flex-col items-center justify-center gap-3">
                        <p className="text-slate-400 text-sm">لا توجد عمليات مسجلة حالياً في هذا الحساب.</p>
                        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                          <button 
                            onClick={() => setShowChat(true)}
                            className="bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all"
                          >
                            <MessageSquare className="w-3.5 h-3.5" />
                            <span>تحدث مع المساعد لإضافة راتب أو مصروف</span>
                          </button>
                          <button 
                            onClick={() => setShowDataBackup(true)}
                            className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all"
                          >
                            <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                            <span>استيراد نسخة احتياطية</span>
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Voice Controls - Fixed to Bottom */}
      <div className="fixed bottom-0 left-0 w-full bg-slate-950/80 backdrop-blur-xl border-t border-slate-800 p-6 flex flex-col items-center justify-center pb-8 shadow-[0_-20px_40px_rgba(0,0,0,0.5)] z-50">
        
        {/* Status Indicator */}
        <div className="mb-6 flex items-center justify-center transition-all duration-300 min-h-[40px]">
          {getStatusDisplay()}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-6">
          {/* Main Mic Button */}
          <div className="relative">
            {/* Dynamic AI talking visualizer ring */}
            {isConnected && status === 'talking' && (
               <div className="absolute inset-0 rounded-full border-2 border-blue-500 animate-ping opacity-50 scale-150"></div>
            )}

            <button
              onClick={handleMicClick}
              className={`relative group flex items-center justify-center w-20 h-20 rounded-full text-white shadow-2xl transition-all duration-500 transform active:scale-95 ${
                isConnected 
                  ? 'bg-rose-600 hover:bg-rose-500 shadow-[0_0_30px_rgba(225,29,72,0.5)]' 
                  : 'bg-emerald-600 hover:bg-emerald-500 shadow-[0_0_30px_rgba(5,150,105,0.4)]'
              }`}
            >
              {isConnected && status === 'listening' && (
                <>
                  <div className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-20"></div>
                </>
              )}
              
              {isConnected ? <MicOff className="w-8 h-8 z-10" /> : <Mic className="w-8 h-8 z-10" />}
            </button>
          </div>

          {/* Camera Scanner Button */}
          <div className="relative">
            <input 
              type="file" 
              accept="image/*,application/pdf,text/plain,text/csv,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,.tsv,.txt,.json,.xlsx" 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleScanReceipt}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isScanning}
              className="flex items-center justify-center w-14 h-14 rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700 shadow-lg transition-all"
              title="استيراد مصروفات من صورة أو ملف أو Excel"
            >
              {isScanning ? <Loader2 className="w-6 h-6 animate-spin text-emerald-400" /> : <FileText className="w-6 h-6" />}
            </button>
          </div>
        </div>
      </div>

      {/* Floating Draggable Chat Button — V6.1 (MOB-01..MOB-06) */}
      <FloatingAssistant
        onToggle={() => setShowChat(!showChat)}
        showChat={showChat}
        hasMessages={chatMessages.length > 0}
      />

      {/* Text Chat Drawer/Modal */}
      {showChat && (
        <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-slate-950/40 backdrop-blur-sm sm:p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 sm:rounded-3xl rounded-t-3xl shadow-2xl flex flex-col h-[80vh] sm:max-h-[600px] overflow-hidden">
            <div className="bg-slate-800 p-4 flex justify-between items-center border-b border-slate-700 shadow-sm z-10 shrink-0">
              <h3 className="font-bold text-slate-200 flex items-center gap-2"><MessageSquare className="w-5 h-5 text-emerald-400" /> الدردشة مع {aiName}</h3>
              <button onClick={() => setShowChat(false)} className="text-slate-400 hover:text-white bg-slate-700/50 hover:bg-slate-700 p-2 rounded-full transition-colors"><X className="w-5 h-5" /></button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scroll-smooth">
              {chatMessages.length === 0 ? (
                <div className="text-center text-slate-500 text-sm mt-10">
                  مرحباً بك يا {userName}، يمكنك التحدث معي كتابياً هنا إن لم تكن ترغب في التحدث بالصوت!
                </div>
              ) : (
                chatMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-start' : 'justify-end'}`}>
                    <div className={`px-4 py-3 rounded-2xl max-w-[85%] text-sm leading-relaxed ${msg.role === 'user' ? 'bg-emerald-600 text-white rounded-tr-none' : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-none'}`}>
                      {msg.text}
                    </div>
                  </div>
                ))
              )}
              {isChatLoading && (
                <div className="flex justify-end">
                  <div className="px-4 py-3 rounded-2xl bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-none text-sm flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-400" /> يكتب...
                  </div>
                </div>
              )}
            </div>
            
            <form onSubmit={handleChatSubmit} className="p-3 border-t border-slate-800 bg-slate-900 flex gap-2 shrink-0">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="اكتب رسالتك..."
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 text-white placeholder-slate-500"
              />
              <button 
                type="submit" 
                disabled={isChatLoading || !chatInput.trim()}
                className="w-12 h-12 shrink-0 bg-emerald-600 text-white rounded-xl flex items-center justify-center hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Send className="w-5 h-5" />
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-md z-[100] flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl relative my-auto">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between shrink-0">
              <h2 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-emerald-400" />
                إعدادات الخبير المالي والمساعد
              </h2>
              <button 
                onClick={() => setShowSettings(false)} 
                className="p-2 bg-slate-800 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
                title="إغلاق"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Scrollable Content Body */}
            <div className="p-5 sm:p-6 overflow-y-auto flex-1 space-y-5">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">اسمك (ليرحب بك)</label>
                <input 
                  type="text" 
                  value={userName} 
                  onChange={e => setUserName(e.target.value)}
                  placeholder="مثال: أبو مصعب"
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-700 text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">اسم الخبير المالي</label>
                <input 
                  type="text" 
                  value={aiName} 
                  onChange={e => setAiName(e.target.value)}
                  placeholder="مثال: مصروفي الذكي"
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-700 text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">علاقة المساعد بك (اختياري)</label>
                <input
                  type="text"
                  value={aiRelationship}
                  onChange={e => setAiRelationship(e.target.value)}
                  placeholder="مثال: زوجتي، صديقتي، مستشارتي"
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-700 text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <p className="text-[11px] text-slate-500 mt-1">اكتب الاسم وحده في الحقل السابق، والعلاقة هنا حتى يفهمها المساعد كسياق لا كجزء من اسمه.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">مفتاح الذكاء الاصطناعي (اختياري)</label>
                <input 
                  type="password" 
                  value={apiKey} 
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="اتركه فارغاً لاستخدام المفتاح الافتراضي"
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-700 text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 text-left" dir="ltr"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">صوت الخبير (الجنس)</label>
                <div className="grid grid-cols-2 gap-3">
                  <button onClick={() => setVoice('Puck')} className={`px-4 py-3 rounded-xl border transition-colors ${voice === 'Puck' ? 'border-emerald-500 bg-emerald-900/30 text-emerald-400 font-bold shadow-[0_0_10px_rgba(16,185,129,0.2)]' : 'border-slate-700 bg-slate-800 text-slate-400'}`}>رجل (Puck)</button>
                  <button onClick={() => setVoice('Zephyr')} className={`px-4 py-3 rounded-xl border transition-colors ${voice === 'Zephyr' ? 'border-emerald-500 bg-emerald-900/30 text-emerald-400 font-bold shadow-[0_0_10px_rgba(16,185,129,0.2)]' : 'border-slate-700 bg-slate-800 text-slate-400'}`}>امرأة (Zephyr)</button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">شخصية الخبير</label>
                <select 
                  value={persona} 
                  onChange={e => setPersona(e.target.value)}
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-700 text-white rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="friendly">عفوي ومرح (صديقك المالي)</option>
                  <option value="playful">مرح جداً ومشاكس</option>
                  <option value="warm">حنون وداعم</option>
                  <option value="romantic">رومانسي ودافئ</option>
                  <option value="professional">رسمي ومهني (مستشار مالي)</option>
                  <option value="strict">صارم وحازم (يعاتبك على الصرف)</option>
                </select>
              </div>

              {/* Memory Management (What AI remembers) */}
              <div className="pt-3 border-t border-slate-800">
                <div className="bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800 text-right">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[11px] text-slate-400 font-normal">المعلومات التي يحفظها عنك المستشار</span>
                    <div className="flex items-center gap-1.5 text-emerald-400 font-bold text-xs">
                      <span>ذاكرة المساعد الذكي</span>
                      <Brain className="w-4 h-4 text-emerald-400" />
                    </div>
                  </div>

                  {/* List of remembered items */}
                  {Object.keys(userMemory).length === 0 ? (
                    <div className="text-center py-2.5 px-3 bg-slate-900/50 rounded-xl border border-slate-800/60 text-slate-400 text-xs">
                      لا توجد معلومات محفوظة في الذاكرة بعد (تحدث مع المساعد ليحفظ راتبك أو التزاماتك تلقائياً أو أضفها أدناه).
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1 mb-3">
                      {Object.entries(userMemory).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between bg-slate-900/80 p-2 rounded-xl border border-slate-800 text-xs">
                          <button
                            type="button"
                            onClick={() => handleDeleteMemoryItem(k)}
                            className="p-1 text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                            title="حذف من الذاكرة"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                          <div className="text-right">
                            <span className="text-emerald-400 font-bold ml-1.5">{k}:</span>
                            <span className="text-slate-200">{v}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add memory item form */}
                  <form onSubmit={handleSaveMemoryItem} className="mt-2 flex gap-1.5 items-center">
                    <button
                      type="submit"
                      disabled={isMemoryLoading || !newMemoryKey || !newMemoryValue}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-colors shrink-0 flex items-center gap-1"
                    >
                      {isMemoryLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      <span>حفظ</span>
                    </button>
                    <input
                      type="text"
                      placeholder="القيمة (مثال: 5000 شيكل في أول الشهر)"
                      value={newMemoryValue}
                      onChange={e => setNewMemoryValue(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 bg-slate-900 border border-slate-700 text-white rounded-lg text-xs focus:outline-none focus:border-emerald-500 text-right"
                    />
                    <input
                      type="text"
                      placeholder="الموضوع (مثال: راتبي)"
                      value={newMemoryKey}
                      onChange={e => setNewMemoryKey(e.target.value)}
                      className="w-24 px-2.5 py-1.5 bg-slate-900 border border-slate-700 text-white rounded-lg text-xs focus:outline-none focus:border-emerald-500 text-right"
                    />
                  </form>
                </div>
              </div>

              {/* Data Backup & Export/Import Trigger inside Settings */}
              <div className="pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setShowSettings(false);
                    setShowDataBackup(true);
                  }}
                  className="w-full py-3 px-4 bg-slate-950 hover:bg-slate-800 border border-slate-700 hover:border-emerald-500/50 rounded-xl text-xs sm:text-sm font-bold text-slate-200 flex items-center justify-between transition-all group"
                >
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg group-hover:scale-110 transition-transform">
                      <HardDrive className="w-4 h-4" />
                    </div>
                    <div className="text-right">
                      <p className="text-white font-bold">إدارة ونسخ وتصفير البيانات (Backup & Reset)</p>
                      <p className="text-[11px] text-slate-400 font-normal">تصدير لـ Excel، حفظ نسخة JSON، استرجاع، أو تصفير شامل</p>
                    </div>
                  </div>
                  <ArrowUpDown className="w-4 h-4 text-emerald-400" />
                </button>
              </div>

              {/* Developer info in settings */}
              <div className="pt-4 border-t border-slate-800 text-right bg-slate-950/40 p-3.5 rounded-2xl border border-slate-800/80">
                <p className="text-xs text-emerald-400 font-bold mb-1 flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5" />
                  <span>برمجة المهندس محمد الهندي (أبو مصعب)</span>
                </p>
                <div className="flex flex-col gap-1 text-[11px] text-slate-400">
                  <a href="tel:+972594403737" className="hover:text-emerald-400 flex items-center gap-1.5" dir="ltr">
                    <Phone className="w-3 h-3 text-slate-500" />
                    <span>+972594403737</span>
                  </a>
                  <a href="mailto:mohammedelhendi1983@gmail.com" className="hover:text-emerald-400 flex items-center gap-1.5" dir="ltr">
                    <Mail className="w-3 h-3 text-slate-500" />
                    <span>mohammedelhendi1983@gmail.com</span>
                  </a>
                </div>
              </div>
            </div>
            
            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-900 rounded-b-3xl shrink-0 flex gap-2">
              <button 
                onClick={() => setShowSettings(false)} 
                className="w-full bg-emerald-600 text-white font-bold py-3 rounded-xl hover:bg-emerald-500 shadow-[0_0_15px_rgba(5,150,105,0.4)] transition-all text-sm"
              >
                حفظ وإغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reports Inbox Modal */}
      {showInbox && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-xl p-6 shadow-2xl relative">
            <button onClick={() => setShowInbox(false)} className="absolute top-4 left-4 p-2 bg-slate-800 rounded-full text-slate-400 hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center justify-between pr-1 mb-1">
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Bell className="w-5 h-5 text-amber-400" />
                حافظة المهام والتقارير المالية
              </h2>
              {reportsList.length > 0 && (
                <button
                  onClick={handleClearAllReports}
                  className="text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 px-2.5 py-1 rounded-lg border border-rose-500/20 transition-all flex items-center gap-1 mr-8"
                  title="مسح جميع التقارير لتفريغ الحافظة"
                >
                  <Trash2 className="w-3 h-3" /> مسح الكل
                </button>
              )}
            </div>
            <p className="text-xs text-slate-400 mb-5">
              استخرج تقارير هيكلية مفصلة حسب البنود الرئيسية والفرعية، واطبعها أو صدّرها لـ Word، أو احذف ما تشاء لمنع التكدس.
            </p>

            {/* Quick Actions */}
            <div className="bg-slate-800/60 border border-slate-700/70 rounded-2xl p-3 mb-5 flex flex-wrap gap-2">
              <button 
                onClick={() => handleGenerateInstantReport('all')}
                className="flex-1 min-w-[140px] px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-emerald-900/30 flex items-center justify-center gap-1.5"
              >
                <span>⚡</span> إنشاء تقرير شامل الآن
              </button>
              <button 
                onClick={() => handleGenerateInstantReport('month')}
                className="flex-1 min-w-[130px] px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-medium transition-all shadow-md shadow-blue-900/30 flex items-center justify-center gap-1.5"
              >
                <span>📅</span> تقرير الشهر الحالي
              </button>
              <button 
                onClick={() => {
                  setActiveReport(null);
                  setShowReports(true);
                }}
                className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5"
              >
                <span>👁️</span> معاينة العمليات الحالية
              </button>
            </div>
            
            <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
              {reportsList.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <FileText className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p className="text-sm font-medium text-slate-400">لا توجد تقارير محفوظة حتى الآن.</p>
                  <p className="text-xs mt-1 text-slate-500">انقر على "إنشاء تقرير شامل الآن" أعلاه أو اطلب من مصروفي بالصوت.</p>
                </div>
              ) : (
                reportsList.map((report) => (
                  <div key={report.id} className="bg-slate-800/50 border border-slate-700 rounded-2xl p-4 flex items-center justify-between hover:bg-slate-800 transition-colors">
                    <div className="flex-1 min-w-0 mr-2">
                      <h4 className="font-bold text-white mb-1 flex items-center gap-2 truncate">
                        <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span className="truncate">{report.title}</span>
                      </h4>
                      <p className="text-xs text-slate-400">
                        تاريخ الإنجاز: {new Date(report.date || report.createdAt).toLocaleDateString('ar-EG')} • {report.transactions ? report.transactions.length : 0} عملية
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button 
                        onClick={() => {
                          setActiveReport(report);
                          setShowReports(true);
                        }}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium rounded-xl transition-colors shadow-lg shadow-emerald-900/20 flex items-center gap-1"
                      >
                        <span>فتح ومعاينة</span>
                      </button>
                      <button 
                        onClick={(e) => handleDeleteReport(report.id, e)}
                        title="حذف هذا التقرير"
                        className="p-1.5 text-rose-400 hover:text-rose-300 hover:bg-rose-500/20 rounded-xl transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reports Modal (Print/Export version) - Styled for light print but dark UI */}
      {showReports && (() => {
        const reportData = buildHierarchicalReport(getReportTransactions(activeReport, transactions));
        const reportTitle = activeReport ? activeReport.title : 'التقرير المالي الهيكلي الشامل لكافة البنود';
        const reportDateFormatted = activeReport 
          ? new Date(activeReport.date || activeReport.createdAt).toLocaleDateString('ar-EG') 
          : new Date().toLocaleDateString('ar-EG');

        return (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[110] flex items-center justify-center p-2 sm:p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-5xl max-h-[94vh] flex flex-col shadow-2xl relative">
              <div className="p-4 sm:p-6 border-b border-slate-800 flex flex-wrap gap-3 items-center justify-between no-print">
                <div>
                  <h2 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2">
                    <FileText className="text-blue-400 w-5 h-5"/> {reportTitle}
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    تفصيل الصرف الهيكلي: البنود الرئيسية &gt; البنود الفرعية &gt; تفاصيل المعاملات
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button 
                    onClick={handleShareWhatsApp}
                    className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs sm:text-sm font-semibold transition-colors shadow-md shadow-emerald-950/40"
                    title="مشاركة التقرير عبر واتساب"
                  >
                    <Share2 className="w-3.5 h-3.5" /> واتساب
                  </button>

                  <button 
                    onClick={handleShareEmail}
                    className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs sm:text-sm font-medium transition-colors"
                    title="إرسال عبر البريد الإلكتروني"
                  >
                    <span>📧</span> بريد
                  </button>

                  <button 
                    onClick={handleCopyReport}
                    className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-xl text-xs sm:text-sm font-medium transition-colors"
                    title="نسخ نص التقرير"
                  >
                    {copiedReport ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedReport ? 'تم النسخ' : 'نسخ'}</span>
                  </button>

                  <button 
                    onClick={printReport} 
                    className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 text-slate-200 border border-slate-700 rounded-xl hover:bg-slate-700 text-xs sm:text-sm font-medium transition-colors"
                  >
                    <Printer className="w-3.5 h-3.5" /> طباعة / PDF
                  </button>

                  <button 
                    onClick={exportWord} 
                    className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-500 shadow-[0_0_10px_rgba(37,99,235,0.3)] text-xs sm:text-sm font-medium transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> Word (.doc)
                  </button>

                  {activeReport && (
                    <button 
                      onClick={() => handleDeleteReport(activeReport.id)} 
                      className="flex items-center gap-1.5 px-3 py-2 bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 rounded-xl text-xs sm:text-sm font-medium transition-colors"
                      title="حذف هذا التقرير من الحافظة"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> حذف التقرير
                    </button>
                  )}

                  <button 
                    onClick={() => { setShowReports(false); setActiveReport(null); }} 
                    className="p-2 bg-rose-500/10 text-rose-400 rounded-xl hover:bg-rose-500/20 mr-1 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>
              
              {/* The report area itself is white to ensure it prints well and exports well */}
              <div className="p-3 sm:p-6 overflow-y-auto flex-1 bg-slate-950/80">
                <div ref={printRef} id="report-content" className="bg-white text-slate-900 p-6 sm:p-10 rounded-2xl shadow-xl mx-auto max-w-4xl border border-slate-200">
                  
                  {/* Official Header */}
                  <div className="text-center mb-8 border-b-2 border-slate-900 pb-6">
                    <div className="inline-block bg-slate-900 text-white text-xs font-bold px-3 py-1 rounded-full mb-3">
                      المستشار والمصرفي المالي الذكي — منصة الرقابة المالية
                    </div>
                    <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-2">
                      {reportTitle}
                    </h1>
                    <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-1 text-xs sm:text-sm text-slate-600 mt-2">
                      <p>المستخدم: <strong className="text-slate-900">{userName}</strong></p>
                      <p>تاريخ الاستخراج: <strong className="text-slate-900">{reportDateFormatted}</strong></p>
                      <p>إجمالي المعاملات: <strong className="text-slate-900">{reportData.allTransactionsCount} عملية</strong></p>
                    </div>
                  </div>

                  {/* KPI Executive Summary Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8 page-break-avoid">
                    <div className="bg-rose-50 border-2 border-rose-200 rounded-xl p-3.5 text-center">
                      <div className="text-xs text-rose-800 font-bold mb-1">إجمالي المصروفات</div>
                      <div className="text-xl sm:text-2xl font-black text-rose-600">
                        {reportData.totalExpenses.toLocaleString()} ₪
                      </div>
                    </div>

                    <div className="bg-emerald-50 border-2 border-emerald-200 rounded-xl p-3.5 text-center">
                      <div className="text-xs text-emerald-800 font-bold mb-1">إجمالي الدخل</div>
                      <div className="text-xl sm:text-2xl font-black text-emerald-600">
                        {reportData.totalIncome.toLocaleString()} ₪
                      </div>
                    </div>

                    <div className="bg-sky-50 border-2 border-sky-200 rounded-xl p-3.5 text-center">
                      <div className="text-xs text-sky-800 font-bold mb-1">صافي الوفر / الفائض</div>
                      <div className={`text-xl sm:text-2xl font-black ${reportData.netSavings >= 0 ? 'text-sky-600' : 'text-rose-600'}`}>
                        {reportData.netSavings >= 0 ? '+' : ''}{reportData.netSavings.toLocaleString()} ₪
                      </div>
                    </div>

                    <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-3.5 text-center">
                      <div className="text-xs text-amber-800 font-bold mb-1">الديون والالتزامات</div>
                      <div className="text-xl sm:text-2xl font-black text-amber-600">
                        {reportData.totalDebt.toLocaleString()} ₪
                      </div>
                    </div>
                  </div>

                  {/* Secondary stats bar: Necessities vs Luxuries & Payment Methods */}
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-8 text-xs sm:text-sm text-slate-700 page-break-avoid">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <span className="font-bold text-slate-900 block mb-1">⚖️ مؤشر نوعية الإنفاق (ضروري مقابل كمالي):</span>
                        <div className="flex items-center gap-3">
                          <span className="text-emerald-700 font-bold">ضروري: {reportData.necessaryTotal.toLocaleString()} ₪ ({reportData.necessaryPercentage.toFixed(1)}%)</span>
                          <span className="text-slate-400">|</span>
                          <span className="text-amber-700 font-bold">كمالي: {reportData.luxuryTotal.toLocaleString()} ₪ ({reportData.luxuryPercentage.toFixed(1)}%)</span>
                        </div>
                      </div>
                      <div>
                        <span className="font-bold text-slate-900 block mb-1">💳 توزيع طرق الدفع:</span>
                        <div className="flex items-center gap-3">
                          <span>💵 كاش: <strong>{reportData.totalCash.toLocaleString()} ₪</strong></span>
                          <span className="text-slate-400">|</span>
                          <span>📱 PalPay: <strong>{reportData.totalPalPay.toLocaleString()} ₪</strong></span>
                          <span className="text-slate-400">|</span>
                          <span>📋 دين: <strong>{reportData.totalDebt.toLocaleString()} ₪</strong></span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Section 1: Main Categories Overview Table */}
                  <div className="mb-10 page-break-avoid">
                    <h3 className="text-base sm:text-lg font-bold text-slate-900 border-b-2 border-slate-300 pb-2 mb-3 flex items-center gap-2">
                      <span>📊</span> جدول التوزيع الإحصائي للبنود الرئيسية
                    </h3>
                    <table className="w-full text-right border-collapse text-xs sm:text-sm">
                      <thead>
                        <tr className="bg-slate-800 text-white">
                          <th className="py-2.5 px-3 font-bold">بند الصرف الرئيسي</th>
                          <th className="py-2.5 px-3 font-bold text-center">عدد البنود الفرعية</th>
                          <th className="py-2.5 px-3 font-bold text-center">عدد العمليات</th>
                          <th className="py-2.5 px-3 font-bold text-center">النسبة المئوية</th>
                          <th className="py-2.5 px-3 font-bold text-left">إجمالي المبلغ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportData.categories.map((cat, idx) => (
                          <tr key={idx} className={idx % 2 === 0 ? 'bg-white border-b border-slate-200' : 'bg-slate-50 border-b border-slate-200'}>
                            <td className="py-2.5 px-3 font-bold text-slate-900 flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-blue-600 inline-block"></span>
                              {cat.name}
                            </td>
                            <td className="py-2.5 px-3 text-center text-slate-700">{cat.subcategories.length}</td>
                            <td className="py-2.5 px-3 text-center text-slate-700">{cat.count}</td>
                            <td className="py-2.5 px-3 text-center">
                              <div className="flex items-center justify-center gap-2">
                                <div className="w-16 bg-slate-200 rounded-full h-2 overflow-hidden">
                                  <div className="bg-blue-600 h-2 rounded-full" style={{ width: `${Math.min(cat.percentageOfTotal, 100)}%` }}></div>
                                </div>
                                <span className="font-bold text-blue-700">{cat.percentageOfTotal.toFixed(1)}%</span>
                              </div>
                            </td>
                            <td className="py-2.5 px-3 font-bold text-left text-rose-700">{cat.total.toLocaleString()} ₪</td>
                          </tr>
                        ))}
                        {reportData.categories.length === 0 && (
                          <tr>
                            <td colSpan={5} className="py-6 text-center text-slate-500">لا توجد مصروفات مسجلة ضمن هذه الفترة.</td>
                          </tr>
                        )}
                      </tbody>
                      {reportData.categories.length > 0 && (
                        <tfoot>
                          <tr className="bg-slate-900 text-white font-bold">
                            <td colSpan={4} className="py-3 px-3">إجمالي كافة المصروفات</td>
                            <td className="py-3 px-3 text-left text-sky-400 text-sm sm:text-base">{reportData.totalExpenses.toLocaleString()} ₪</td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                  </div>

                  {/* Section 2: Detailed Hierarchical Breakdown */}
                  <div className="mb-10">
                    <h3 className="text-base sm:text-lg font-bold text-slate-900 border-b-2 border-slate-900 pb-2 mb-6 flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span>📑</span> التفصيل الهيكلي الكامل للمصروفات
                      </span>
                      <span className="text-xs font-normal text-slate-500">
                        (بند رئيسي &gt; بند فرعي &gt; المعاملات)
                      </span>
                    </h3>

                    {reportData.categories.map((cat, catIdx) => (
                      <div key={catIdx} className="mb-8 border-2 border-slate-800 rounded-2xl overflow-hidden shadow-sm page-break-avoid">
                        {/* Main Category Banner */}
                        <div className="bg-slate-900 text-white px-4 py-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-xs text-white">
                              {catIdx + 1}
                            </span>
                            <h4 className="font-extrabold text-base sm:text-lg text-white">
                              بند الصرف الرئيسي: {cat.name}
                            </h4>
                          </div>
                          <div className="flex items-center gap-3 text-xs sm:text-sm">
                            <span className="bg-blue-500/20 text-blue-300 border border-blue-400/30 px-2.5 py-0.5 rounded-lg">
                              {cat.subcategories.length} بنود فرعية • {cat.count} عملية
                            </span>
                            <span className="bg-sky-400 text-slate-950 font-black px-3 py-1 rounded-lg text-sm">
                              الإجمالي: {cat.total.toLocaleString()} ₪ ({cat.percentageOfTotal.toFixed(1)}%)
                            </span>
                          </div>
                        </div>

                        {/* Subcategories inside this Main Category */}
                        <div className="p-4 bg-slate-50/50 space-y-6">
                          {cat.subcategories.map((sub, subIdx) => (
                            <div key={subIdx} className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                              {/* Subcategory Header */}
                              <div className="bg-slate-100/90 border-b border-slate-200 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
                                <div className="font-bold text-slate-900 text-sm flex items-center gap-2">
                                  <span className="text-blue-600 font-bold">📌</span>
                                  <span>البند الفرعي: <strong className="text-blue-900">{sub.name}</strong></span>
                                  <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full font-normal">
                                    {sub.count} عملية
                                  </span>
                                </div>
                                <div className="text-xs sm:text-sm font-bold text-blue-800">
                                  المجموع الفرعي: <span className="text-rose-700 font-black">{sub.total.toLocaleString()} ₪</span>
                                </div>
                              </div>

                              {/* Detailed Transactions Table for this Subcategory */}
                              <table className="w-full text-right border-collapse text-xs sm:text-sm">
                                <thead>
                                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-700 font-semibold">
                                    <th className="py-2 px-3 w-[22%]">اليوم والتاريخ</th>
                                    <th className="py-2 px-3 w-[30%]">البيان / شو اشتريت</th>
                                    <th className="py-2 px-3 w-[16%]">المتجر / الجهة</th>
                                    <th className="py-2 px-3 w-[12%] text-center">طريقة الدفع</th>
                                    <th className="py-2 px-3 w-[10%] text-center">الأهمية</th>
                                    <th className="py-2 px-3 w-[10%] text-left">المبلغ</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {sub.items.map((item, itemIdx) => (
                                    <tr key={item.id || itemIdx} className={itemIdx % 2 === 0 ? 'bg-white border-b border-slate-100' : 'bg-slate-50/60 border-b border-slate-100'}>
                                      <td className="py-2 px-3 text-slate-700 font-medium whitespace-nowrap">
                                        {item.formattedDate}
                                      </td>
                                      <td className="py-2 px-3 font-semibold text-slate-900">
                                        {item.notes || item.subcategory || 'شراء متفرقات'}
                                      </td>
                                      <td className="py-2 px-3 text-slate-600">
                                        {item.merchant || '—'}
                                      </td>
                                      <td className="py-2 px-3 text-center">
                                        {item.account === 'debt' ? (
                                          <span className="inline-block bg-rose-100 text-rose-800 text-[11px] font-bold px-2 py-0.5 rounded">
                                            📋 دين
                                          </span>
                                        ) : item.account === 'palPay' ? (
                                          <span className="inline-block bg-blue-100 text-blue-800 text-[11px] font-bold px-2 py-0.5 rounded">
                                            📱 PalPay
                                          </span>
                                        ) : (
                                          <span className="inline-block bg-slate-100 text-slate-800 text-[11px] font-medium px-2 py-0.5 rounded">
                                            💵 كاش
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-2 px-3 text-center">
                                        {item.necessity === 'ضروري' ? (
                                          <span className="text-emerald-700 font-bold text-[11px]">🟢 ضروري</span>
                                        ) : (
                                          <span className="text-amber-700 font-bold text-[11px]">🟡 كمالي</span>
                                        )}
                                      </td>
                                      <td className="py-2 px-3 font-bold text-left text-rose-600 whitespace-nowrap">
                                        {item.amount.toLocaleString()} ₪
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                                <tfoot>
                                  <tr className="bg-slate-100/70 border-t border-slate-200 text-slate-800 font-bold">
                                    <td colSpan={5} className="py-2 px-3 text-right">
                                      مجموع بند ({sub.name})
                                    </td>
                                    <td className="py-2 px-3 text-left text-rose-700 font-black">
                                      {sub.total.toLocaleString()} ₪
                                    </td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          ))}
                        </div>

                        {/* Category Summary Footer */}
                        <div className="bg-slate-100 border-t-2 border-slate-800 px-4 py-2.5 flex justify-between items-center text-xs sm:text-sm font-bold text-slate-900">
                          <span>إجمالي مصروفات ({cat.name})</span>
                          <span className="text-rose-700 font-black text-sm sm:text-base">{cat.total.toLocaleString()} ₪</span>
                        </div>
                      </div>
                    ))}

                    {reportData.categories.length === 0 && (
                      <div className="bg-slate-50 border-2 border-dashed border-slate-300 rounded-2xl p-8 text-center text-slate-600">
                        <div className="w-12 h-12 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center mx-auto mb-3 text-xl">
                          📋
                        </div>
                        <h4 className="font-bold text-slate-800 text-base mb-1">لا توجد عمليات مسجلة مطابقة لهذا البند حالياً</h4>
                        <p className="text-xs text-slate-500 max-w-md mx-auto mb-4">
                          بمجرد تسجيل أي عملية صوتياً أو كتابياً (مثال: «سجل 50 شيكل مصروف لأحمد كاش»)، سيتم تصنيفها وإدراجها فوراً في هذا التقرير التفصيلي.
                        </p>
                        {activeReport && (
                          <button
                            onClick={() => setActiveReport(null)}
                            className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-500 transition-colors shadow-sm"
                          >
                            معاينة التقرير الشامل لكافة البنود ({transactions.length} عملية)
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Section 3: Income breakdown if available */}
                  {reportData.incomes.length > 0 && (
                    <div className="mb-8 border border-emerald-300 rounded-2xl overflow-hidden shadow-sm page-break-avoid">
                      <div className="bg-emerald-800 text-white px-4 py-3 flex justify-between items-center">
                        <h4 className="font-bold text-sm sm:text-base flex items-center gap-2">
                          <span>💰</span> جدول مصادر الدخل والمبالغ المرحّلة
                        </h4>
                        <span className="bg-emerald-950 text-emerald-300 font-black px-3 py-1 rounded-lg text-xs sm:text-sm">
                          إجمالي الدخل: {reportData.totalIncome.toLocaleString()} ₪
                        </span>
                      </div>
                      <table className="w-full text-right border-collapse text-xs sm:text-sm">
                        <thead>
                          <tr className="bg-emerald-50 text-emerald-950 font-semibold border-b border-emerald-200">
                            <th className="py-2 px-3">التاريخ</th>
                            <th className="py-2 px-3">المصدر / البيان</th>
                            <th className="py-2 px-3">الحساب المستقبل</th>
                            <th className="py-2 px-3 text-left">المبلغ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportData.incomes.map((inc, incIdx) => (
                            <tr key={inc.id || incIdx} className="border-b border-emerald-100 bg-white">
                              <td className="py-2 px-3 text-slate-700">{inc.formattedDate}</td>
                              <td className="py-2 px-3 font-bold text-slate-900">{inc.category} {inc.notes ? `- ${inc.notes}` : ''}</td>
                              <td className="py-2 px-3 text-slate-600">{inc.accountLabel}</td>
                              <td className="py-2 px-3 font-bold text-left text-emerald-700">+{inc.amount.toLocaleString()} ₪</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Section 4: Strategic Advisory Insights */}
                  <div className="bg-slate-50 border-2 border-slate-300 rounded-2xl p-5 mb-8 page-break-avoid">
                    <h4 className="font-bold text-slate-900 text-sm sm:text-base mb-3 flex items-center gap-2">
                      <span>💡</span> تحليلات وتوصيات المستشار المالي الذكي
                    </h4>
                    <ul className="space-y-2 text-xs sm:text-sm text-slate-700 list-disc list-inside">
                      {reportData.recommendations.map((rec, rIdx) => (
                        <li key={rIdx} className="leading-relaxed">{rec}</li>
                      ))}
                    </ul>
                  </div>

                  {/* Footer / Official Stamp */}
                  <div className="border-t-2 border-slate-900 pt-6 mt-8 flex flex-wrap justify-between items-center text-xs text-slate-500 page-break-avoid">
                    <div>
                      <p className="font-bold text-slate-800">منصة المصرفي الذكي — مكتب الرقابة والتدقيق المالي</p>
                      <p>تم تدقيق وهيكلة البيانات آلياً وفق معايير المحاسبة التحليلية</p>
                    </div>
                    <div className="text-left mt-2 sm:mt-0">
                      <p>الاعتماد: <strong>المستشار المالي الذكي ({aiName})</strong></p>
                      <p>الرمز المرجعي: {Math.random().toString(36).substring(2, 9).toUpperCase()}</p>
                    </div>
                  </div>

                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Savings Goals Modal */}
      {showSavings && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[105] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col p-6 shadow-2xl relative">
            <button onClick={() => setShowSavings(false)} className="absolute top-4 left-4 p-2 bg-slate-800 rounded-full text-slate-400 hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 bg-emerald-500/20 text-emerald-400 rounded-2xl border border-emerald-500/30">
                <PiggyBank className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">خانة المدخرات والأهداف</h2>
                <p className="text-xs text-slate-400">حدد هدفاً مثل 5000 ₪ خلال سنة، وسأحسب لك المطلوب شهرياً وأنبهك بالأحمر عند وصول الرصيد المتبقي لهذا الحد.</p>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 my-4 space-y-4 pr-1">
              {activeSavingsGoals.map((goal: any) => {
                const pct = Math.min(100, Number(goal.progressPercentage || 0));
                const critical = goal.alertLevel === 'critical';
                const warning = goal.alertLevel === 'warning';
                return (
                  <div key={goal.id} className={`p-4 rounded-2xl border ${critical ? 'bg-rose-950/30 border-rose-500/40' : warning ? 'bg-amber-950/30 border-amber-500/40' : 'bg-slate-950/50 border-slate-800'}`}>
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-bold text-white">{goal.name}</span>
                          {critical && <span className="bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[10px] px-2 py-0.5 rounded-full flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> خطر</span>}
                          {warning && <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] px-2 py-0.5 rounded-full">تنبيه</span>}
                        </div>
                        <p className="text-[11px] text-slate-400">الموعد: {goal.dueDate || 'غير محدد'} · باقي {Number(goal.daysRemaining || 0)} يوم</p>
                      </div>
                      <div className="text-left shrink-0">
                        <p className="text-xs text-slate-400">شهرياً</p>
                        <p className="text-lg font-black text-emerald-300">{Number(goal.monthlyRequired || 0).toLocaleString()} ₪</p>
                      </div>
                    </div>
                    <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                      <div className={`h-2.5 rounded-full ${critical ? 'bg-rose-500' : warning ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }}></div>
                    </div>
                    <div className="flex justify-between text-[11px] text-slate-400 mt-2">
                      <span>ادخرت: <strong className="text-white">{Number(goal.savedAmount || 0).toLocaleString()} ₪</strong> من {Number(goal.targetAmount || 0).toLocaleString()} ₪</span>
                      <span>هذا الشهر: <strong className="text-emerald-300">{Number(goal.monthlySavedAmount || 0).toLocaleString()} ₪</strong></span>
                    </div>
                    {(critical || warning) && <p className={`mt-3 text-xs ${critical ? 'text-rose-100' : 'text-amber-100'}`}>{goal.alertMessage}</p>}
                  </div>
                );
              })}

              {activeSavingsGoals.length === 0 && (
                <div className="text-center py-8 text-slate-500 text-sm">
                  لا توجد أهداف ادخار نشطة بعد. أنشئ هدفاً جديداً من الأسفل.
                </div>
              )}
            </div>

            <div className="pt-4 border-t border-slate-800 grid grid-cols-1 md:grid-cols-2 gap-4">
              <form onSubmit={handleCreateSavingsGoal} className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4 space-y-2">
                <h3 className="text-sm font-bold text-white flex items-center gap-2"><Target className="w-4 h-4 text-emerald-400" /> هدف جديد</h3>
                <input value={newSavingsName} onChange={e => setNewSavingsName(e.target.value)} placeholder="اسم الهدف: سيارة، طوارئ، تعليم" className="w-full px-3 py-2 bg-slate-900 border border-slate-700 text-white rounded-xl text-xs" />
                <div className="grid grid-cols-2 gap-2">
                  <input type="number" value={newSavingsTarget} onChange={e => setNewSavingsTarget(e.target.value)} placeholder="المبلغ ₪" className="px-3 py-2 bg-slate-900 border border-slate-700 text-white rounded-xl text-xs" />
                  <input type="number" value={newSavingsDurationMonths} onChange={e => setNewSavingsDurationMonths(e.target.value)} placeholder="المدة بالشهور" className="px-3 py-2 bg-slate-900 border border-slate-700 text-white rounded-xl text-xs" />
                </div>
                <button disabled={isSavingsSaving} className="w-full px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs rounded-xl transition-all">
                  {isSavingsSaving ? 'جارٍ الحفظ...' : '+ إنشاء هدف'}
                </button>
              </form>

              <form onSubmit={handleAddSavingsContribution} className="bg-slate-950/50 border border-slate-800 rounded-2xl p-4 space-y-2">
                <h3 className="text-sm font-bold text-white flex items-center gap-2"><PiggyBank className="w-4 h-4 text-emerald-400" /> ادخار مبلغ</h3>
                <select value={savingsContributionGoalId} onChange={e => setSavingsContributionGoalId(e.target.value)} className="w-full px-3 py-2 bg-slate-900 border border-slate-700 text-white rounded-xl text-xs">
                  <option value="">{activeSavingsGoals.length === 1 ? 'سيتم اختيار الهدف الوحيد تلقائياً' : 'اختر هدف الادخار'}</option>
                  {activeSavingsGoals.map((g: any) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <input type="number" value={savingsContributionAmount} onChange={e => setSavingsContributionAmount(e.target.value)} placeholder="المبلغ الذي تريد ادخاره ₪" className="w-full px-3 py-2 bg-slate-900 border border-slate-700 text-white rounded-xl text-xs" />
                <button disabled={isSavingsSaving} className="w-full px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold text-xs rounded-xl transition-all">
                  {isSavingsSaving ? 'جارٍ الإضافة...' : '+ ادخار'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Smart Budgets & Pre-Alerts Modal */}
      {showBudgets && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[105] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col p-6 shadow-2xl relative">
            <button onClick={() => setShowBudgets(false)} className="absolute top-4 left-4 p-2 bg-slate-800 rounded-full text-slate-400 hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 bg-amber-500/20 text-amber-400 rounded-2xl border border-amber-500/30">
                <Target className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">نظام الموازنات الذكية والتنبيه المسبق</h2>
                <p className="text-xs text-slate-400">حدد سقفاً مالياً شهرياً لكل بند رئيسي، وسينبهك المصرفي صوتياً وآلياً عند الاقتراب من 80%</p>
              </div>
            </div>

            {/* Budgets List */}
            <div className="overflow-y-auto flex-1 my-4 space-y-4 pr-1">
              {(budgetsData.budgets || []).map((b: any, idx: number) => {
                const percentage = Math.min(b.percentage || 0, 100);
                const isWarning = b.status === 'warning';
                const isExceeded = b.status === 'exceeded';
                
                return (
                  <div key={idx} className={`p-4 rounded-2xl border transition-all ${
                    isExceeded 
                      ? 'bg-rose-950/30 border-rose-500/40' 
                      : isWarning 
                        ? 'bg-amber-950/30 border-amber-500/40' 
                        : 'bg-slate-950/50 border-slate-800'
                  }`}>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white text-base">{b.category}</span>
                        {isExceeded && (
                          <span className="bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" /> تم تجاوز السقف
                          </span>
                        )}
                        {isWarning && (
                          <span className="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" /> تنبيه (اقترب من السقف)
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-slate-200">
                          {b.spent.toLocaleString()} ₪ <span className="text-slate-500 font-normal">من أصل</span> {b.limit.toLocaleString()} ₪
                        </span>

                        {editingBudgetCat === b.category ? (
                          <div className="flex items-center gap-1">
                            <input 
                              type="number"
                              value={editingBudgetLimit}
                              onChange={e => setEditingBudgetLimit(e.target.value)}
                              placeholder="السقف الجديد"
                              className="w-24 px-2 py-1 bg-slate-900 border border-emerald-500 rounded text-xs text-white text-left font-mono"
                              autoFocus
                            />
                            <button 
                              onClick={() => handleSaveBudgetLimit(b.category, Number(editingBudgetLimit))}
                              className="px-2 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-xs font-bold"
                            >
                              حفظ
                            </button>
                            <button 
                              onClick={() => setEditingBudgetCat(null)}
                              className="px-1.5 py-1 bg-slate-800 text-slate-400 rounded text-xs"
                            >
                              إلغاء
                            </button>
                          </div>
                        ) : (
                          <button 
                            onClick={() => {
                              setEditingBudgetCat(b.category);
                              setEditingBudgetLimit(b.limit.toString());
                            }}
                            className="text-xs text-emerald-400 hover:text-emerald-300 underline"
                          >
                            تعديل السقف
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                      <div 
                        className={`h-2.5 rounded-full transition-all duration-500 ${
                          isExceeded ? 'bg-rose-500' : isWarning ? 'bg-amber-500' : 'bg-emerald-500'
                        }`} 
                        style={{ width: `${percentage}%` }}
                      ></div>
                    </div>

                    <div className="flex justify-between text-[11px] text-slate-400 mt-1.5">
                      <span>نسبة الاستهلاك: <strong className={isExceeded ? 'text-rose-400' : isWarning ? 'text-amber-400' : 'text-emerald-400'}>{b.percentage}%</strong></span>
                      <span>المتبقي: <strong className={b.remaining < 0 ? 'text-rose-400' : 'text-slate-300'}>{b.remaining.toLocaleString()} ₪</strong></span>
                    </div>
                  </div>
                );
              })}

              {(!budgetsData.budgets || budgetsData.budgets.length === 0) && (
                <div className="text-center py-8 text-slate-500 text-sm">
                  لا توجد موازنات محددة حالياً. يمكنك تحديد سقف لأي بند أدناه!
                </div>
              )}
            </div>

            {/* Quick Set New Budget Form */}
            <div className="pt-4 border-t border-slate-800 flex flex-wrap gap-2 items-center">
              <input 
                type="text" 
                placeholder="اسم البند (مثال: الأبناء، طعام ومشروبات، زيارات)"
                id="new-budget-cat-input"
                className="flex-1 min-w-[180px] px-3 py-2 bg-slate-950 border border-slate-700 text-white rounded-xl text-xs"
              />
              <input 
                type="number" 
                placeholder="السقف الشهري (₪)"
                id="new-budget-limit-input"
                className="w-32 px-3 py-2 bg-slate-950 border border-slate-700 text-white rounded-xl text-xs"
              />
              <button 
                onClick={() => {
                  const catInput = document.getElementById('new-budget-cat-input') as HTMLInputElement;
                  const limitInput = document.getElementById('new-budget-limit-input') as HTMLInputElement;
                  if (catInput?.value && limitInput?.value) {
                    handleSaveBudgetLimit(catInput.value.trim(), Number(limitInput.value));
                    catInput.value = '';
                    limitInput.value = '';
                  }
                }}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs rounded-xl shadow-md transition-all"
              >
                + ضبط الموازنة
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Commitments & Cash Flow Forecast Modal */}
      {showCommitments && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[105] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col p-6 shadow-2xl relative">
            <button onClick={() => setShowCommitments(false)} className="absolute top-4 left-4 p-2 bg-slate-800 rounded-full text-slate-400 hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
            
            <div className="flex items-center gap-3 mb-2">
              <div className="p-2.5 bg-sky-500/20 text-sky-400 rounded-2xl border border-sky-500/30">
                <Calendar className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">المساعد التنبؤي للرواتب والالتزامات والأقساط</h2>
                <p className="text-xs text-slate-400">تتبع استحقاقات الإيجار، أقساط الجامعات، الفواتير مع حساب الرصيد الصافي المتبقي بعد الالتزام</p>
              </div>
            </div>

            {/* Predictive Financial Summary Box */}
            {(() => {
              // Forecast uses data already loaded in the dashboard: zero additional Firestore reads.
              // Loans received, debt payments and internal transfers are deliberately excluded from income/expense trends.
              const now = new Date();
              const horizonMs = 90 * 24 * 60 * 60 * 1000;
              const recent = transactions.filter((t: any) => {
                const d = new Date(t.date || t.createdAt || 0);
                return !Number.isNaN(d.getTime()) && now.getTime() - d.getTime() >= 0 && now.getTime() - d.getTime() <= horizonMs;
              });
              const realIncome90 = recent.filter((t: any) => t.type === 'income' && t.transactionType !== 'DEBT_BORROWING')
                .reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0);
              const realExpense90 = recent.filter((t: any) => t.type === 'expense')
                .reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0);
              const historyDays = recent.length ? Math.max(30, Math.min(90, Math.ceil((now.getTime() - Math.min(...recent.map((t: any) => new Date(t.date || t.createdAt).getTime()))) / 86400000) + 1)) : 30;
              const projectedIncome30 = Math.round((realIncome90 / historyDays) * 30);
              const projectedExpense30 = Math.round((realExpense90 / historyDays) * 30);
              const next30 = new Date(now.getTime() + 30 * 86400000);
              const dueCommitments30 = commitments.filter((c: any) => {
                const d = new Date(c.dueDate);
                return !Number.isNaN(d.getTime()) && d >= now && d <= next30;
              }).reduce((sum: number, c: any) => sum + (Number(c.amount) || 0), 0);
              const overdueCommitments = commitments.filter((c: any) => new Date(c.dueDate) < now)
                .reduce((sum: number, c: any) => sum + (Number(c.amount) || 0), 0);
              const predicted30 = Math.round(balance + projectedIncome30 - projectedExpense30 - dueCommitments30 - overdueCommitments);
              const confidence = recent.length >= 30 ? 'جيدة' : recent.length >= 10 ? 'متوسطة' : 'أولية';
              return (
                <div className="bg-slate-950/80 border border-slate-800 p-4 rounded-2xl my-3">
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-center">
                    <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                      <p className="text-[11px] text-slate-400">الرصيد الحالي</p>
                      <p className="text-lg font-bold text-white">{balance.toLocaleString()} ₪</p>
                    </div>
                    <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                      <p className="text-[11px] text-slate-400">دخل متوقع / 30 يوم</p>
                      <p className="text-lg font-bold text-emerald-400">+{projectedIncome30.toLocaleString()} ₪</p>
                    </div>
                    <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                      <p className="text-[11px] text-slate-400">مصروف متوقع + مستحقات</p>
                      <p className="text-lg font-bold text-rose-400">-{(projectedExpense30 + dueCommitments30 + overdueCommitments).toLocaleString()} ₪</p>
                    </div>
                    <div className="bg-slate-900 p-2.5 rounded-xl border border-slate-800">
                      <p className="text-[11px] text-slate-400">الرصيد المتوقع بعد 30 يوم</p>
                      <p className={`text-lg font-bold ${predicted30 < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>{predicted30.toLocaleString()} ₪</p>
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-500 mt-2 text-center">توقع إرشادي مبني على آخر {historyDays} يوم من سجلك الفعلي والالتزامات المسجلة — دقة {confidence}. لا تُحتسب الاستدانة كدخل ولا سداد الدين كمصروف جديد.</p>
                </div>
              );
            })()}

            {/* Commitments List */}
            <div className="overflow-y-auto flex-1 my-2 space-y-3 pr-1">
              {commitments.map((c: any) => (
                <div key={c.id} className="bg-slate-950/60 border border-slate-800 p-3.5 rounded-2xl flex items-center justify-between gap-3 hover:border-slate-700 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-xl text-xs font-bold ${
                      c.isOverdue ? 'bg-rose-500/20 text-rose-400' : c.isDueSoon ? 'bg-amber-500/20 text-amber-400' : 'bg-sky-500/20 text-sky-400'
                    }`}>
                      {c.daysRemaining !== undefined && c.daysRemaining < 0 ? `متأخر ${Math.abs(c.daysRemaining)} يوم` : c.daysRemaining === 0 ? 'اليوم' : `${c.daysRemaining} يوم متبقي`}
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-white flex items-center gap-2">
                        {c.title}
                        {c.category && <span className="text-[10px] text-slate-400 font-normal">({c.category})</span>}
                      </h4>
                      <p className="text-xs text-slate-400">موعد الاستحقاق: {c.dueDate}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="font-bold text-rose-400 text-sm sm:text-base">
                      {c.amount.toLocaleString()} ₪
                    </span>
                    <button 
                      onClick={() => handleDeleteCommitment(c.id)}
                      className="p-1.5 text-slate-500 hover:text-rose-400 rounded-lg hover:bg-rose-500/10 transition-colors"
                      title="حذف الالتزام"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}

              {commitments.length === 0 && (
                <div className="text-center py-8 text-slate-500 text-sm">
                  لا توجد التزامات مجدولة. أضف التزامك المالي القادم أدناه!
                </div>
              )}
            </div>

            {/* Add Commitment Form */}
            <form onSubmit={handleCreateCommitment} className="pt-3 border-t border-slate-800 flex flex-wrap gap-2 items-center">
              <input 
                type="text" 
                value={newCommitmentTitle}
                onChange={e => setNewCommitmentTitle(e.target.value)}
                placeholder="اسم الالتزام (مثال: قسط جامعة، إيجار البيت، فاتورة كهرباء)"
                className="flex-1 min-w-[170px] px-3 py-2 bg-slate-950 border border-slate-700 text-white rounded-xl text-xs"
                required
              />
              <input 
                type="number" 
                value={newCommitmentAmount}
                onChange={e => setNewCommitmentAmount(e.target.value)}
                placeholder="المبلغ (₪)"
                className="w-24 px-3 py-2 bg-slate-950 border border-slate-700 text-white rounded-xl text-xs"
                required
              />
              <input 
                type="date" 
                value={newCommitmentDate}
                onChange={e => setNewCommitmentDate(e.target.value)}
                className="px-3 py-2 bg-slate-950 border border-slate-700 text-white rounded-xl text-xs"
                required
              />
              <button 
                type="submit"
                className="px-4 py-2 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs rounded-xl shadow-md transition-all"
              >
                + إضافة التزام
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Multi-Item Scanner Decomposed Result Modal */}
      {showScannerResult && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[120] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-2xl max-h-[90vh] flex flex-col p-6 shadow-2xl relative">
            <button onClick={() => setShowScannerResult(null)} className="absolute top-4 left-4 p-2 bg-slate-800 rounded-full text-slate-400 hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
            
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2.5 bg-emerald-500/20 text-emerald-400 rounded-2xl border border-emerald-500/30">
                <Camera className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-white">تم تحليل المصروفات ولم يتم تسجيلها بعد</h2>
                <p className="text-xs text-slate-400">
                  المصدر: <strong className="text-emerald-400">{showScannerResult.merchant || 'صورة / ملف مصروفات'}</strong> • إجمالي المسودة: <strong className="text-white">{showScannerResult.totalAmount || 0} ₪</strong> ({showScannerResult.itemsCount || 0} بنود)
                </p>
              </div>
            </div>

            {(showScannerResult.warnings || []).length > 0 && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-3 mb-3 text-xs text-amber-100 space-y-1">
                {(showScannerResult.warnings || []).slice(0, 5).map((warning: string, idx: number) => <p key={idx}>⚠️ {warning}</p>)}
                {(showScannerResult.warnings || []).length > 5 && <p>ويوجد تحذيرات إضافية. راجع الملف قبل الاعتماد.</p>}
              </div>
            )}

            {scannerHasMissingDates && (
              <div className="bg-slate-950/70 border border-amber-500/30 rounded-2xl p-3 mb-3 text-xs text-amber-100 space-y-3">
                <p className="font-bold">اكتب تاريخ كل بند ناقص في خانته الخاصة. لن يبدأ التسجيل حتى تكتمل التواريخ.</p>
                <div className="space-y-2">
                  {(showScannerResult.items || []).map((item: any, idx: number) => {
                    if (isCompleteScannedReceiptDate(item?.date)) return null;
                    return (
                      <div key={`missing-date-${idx}`} className="bg-slate-900/80 border border-amber-500/40 rounded-xl p-3 space-y-2">
                        <div className="text-slate-100 font-semibold leading-relaxed">{idx + 1}. {item.notes || item.name || 'بند ناقص التاريخ'}</div>
                        <input
                          type="text"
                          inputMode="text"
                          autoComplete="off"
                          placeholder="مثال: 18/7/2026 أو 18072026"
                          onChange={(e) => setShowScannerResult((prev: any) => {
                            if (!prev) return prev;
                            const nextItems = [...(prev.items || [])];
                            nextItems[idx] = { ...nextItems[idx], date: normalizeScannedReceiptDateInput(e.target.value), dateSource: 'user-confirmed-date' };
                            return { ...prev, items: nextItems };
                          })}
                          className="w-full bg-slate-950 border-2 border-amber-400 rounded-xl px-4 py-3 text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-300"
                          aria-label={`أدخل تاريخ البند الناقص ${idx + 1}`}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="overflow-y-auto flex-1 my-3 pr-1">
              <table className="w-full text-right border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-950 text-slate-400 border-b border-slate-800">
                    <th className="py-2 px-3">التاريخ</th>
                    <th className="py-2 px-3">البند / المشتريات</th>
                    <th className="py-2 px-3">التصنيف الرئيسي</th>
                    <th className="py-2 px-3">البند الفرعي</th>
                    <th className="py-2 px-3 text-center">النوع</th>
                    <th className="py-2 px-3 text-left">المبلغ</th>
                  </tr>
                </thead>
                <tbody>
                  {(showScannerResult.items || []).map((item: any, idx: number) => (
                    <tr key={idx} className="border-b border-slate-800/60 bg-slate-950/30 hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">
                        <input
                          type="text"
                          inputMode="text"
                          autoComplete="off"
                          placeholder="18/7/2026 أو 18072026"
                          value={item.date ? String(item.date).slice(0, 10) : ''}
                          onChange={(e) => setShowScannerResult((prev: any) => {
                            if (!prev) return prev;
                            const nextItems = [...(prev.items || [])];
                            nextItems[idx] = { ...nextItems[idx], date: normalizeScannedReceiptDateInput(e.target.value), dateSource: 'user-confirmed-date' };
                            return { ...prev, items: nextItems };
                          })}
                          className={`w-32 bg-slate-950 border rounded-lg px-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500 ${item.date ? 'border-slate-700' : 'border-amber-400 ring-1 ring-amber-400/40'}`}
                          aria-label={`تاريخ البند ${idx + 1}`}
                        />
                        {!isCompleteScannedReceiptDate(item.date) && <div className="text-[10px] text-amber-300 mt-1">بحاجة تاريخ كامل</div>}
                      </td>
                      <td className="py-2.5 px-3 font-semibold text-white">{item.notes || item.name}</td>
                      <td className="py-2.5 px-3 text-slate-300">{item.category}</td>
                      <td className="py-2.5 px-3 text-slate-400">{item.subcategory || 'عام'}</td>
                      <td className="py-2.5 px-3 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] ${
                          item.necessity === 'ضروري' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                        }`}>
                          {item.necessity || 'ضروري'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-bold text-left text-rose-400">-{item.amount} ₪</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pt-3 border-t border-slate-800 space-y-3">
              <p className="text-xs text-slate-400">هذه مسودة فقط. اختر طريقة الدفع حتى تُحفظ فعلياً في الخزينة.</p>
              <div className="grid grid-cols-3 gap-2">
                <button disabled={isRecordingScannedReceipt || scannerHasMissingDates} onClick={() => handleRecordScannedReceipt('cash')} className="px-3 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl text-xs shadow-lg transition-all">{isRecordingScannedReceipt ? 'جارٍ التسجيل...' : 'سجلها كاش'}</button>
                <button disabled={isRecordingScannedReceipt || scannerHasMissingDates} onClick={() => handleRecordScannedReceipt('palPay')} className="px-3 py-2.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl text-xs shadow-lg transition-all">{isRecordingScannedReceipt ? 'جارٍ التسجيل...' : 'سجلها PalPay'}</button>
                <button disabled={isRecordingScannedReceipt || scannerHasMissingDates} onClick={() => handleRecordScannedReceipt('debt')} className="px-3 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-xl text-xs shadow-lg transition-all">{isRecordingScannedReceipt ? 'جارٍ التسجيل...' : 'سجلها دين'}</button>
              </div>
              <button 
                onClick={() => setShowScannerResult(null)}
                className="w-full px-6 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl text-xs transition-all"
              >
                إلغاء بدون تسجيل
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Data Backup & Export/Import Modal */}
      <DataBackupModal
        isOpen={showDataBackup}
        onClose={() => setShowDataBackup(false)}
        idToken={idToken}
        userName={userName}
        transactionsCount={transactions.length}
        budgetsCount={Number(budgetsData.customBudgetCount ?? 0)}
        commitmentsCount={commitments.length}
        reportsCount={reportsList.length}
        onRefreshData={() => {
          // Trigger custom event so all balances and transactions refresh
          window.dispatchEvent(new CustomEvent('masrofi:refresh'));
        }}
      />

      {/* Footer */}
      <footer className="w-full max-w-md mx-auto mt-8 mb-32 text-center relative z-10">
        <div className="bg-slate-900/40 border border-slate-800/60 rounded-2xl p-4 shadow-lg backdrop-blur-sm mx-4">
          <p className="text-slate-300 text-sm font-medium mb-1 flex items-center justify-center gap-2">
            <span className="text-emerald-500">💻</span> برمجة المهندس: محمد الهندي (أبو مصعب)
          </p>
          <p className="text-slate-400 text-sm flex items-center justify-center gap-2 mb-2" dir="ltr">
            <a href="https://wa.me/972594403737" target="_blank" rel="noreferrer" className="hover:text-emerald-400 transition-colors flex items-center gap-2 font-mono">
              +972 59-440-3737 <span className="text-emerald-500">📱</span>
            </a>
          </p>
          <div className="mt-2 pt-2 border-t border-slate-800/60 text-xs text-slate-500">
            كلمة للمبرمج
          </div>
        </div>
      </footer>

    </div>
  );
}
