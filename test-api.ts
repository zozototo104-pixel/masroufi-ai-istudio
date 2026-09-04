import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import firebaseConfig from './firebase-applet-config.json';
const app = initializeApp({ projectId: firebaseConfig.projectId });
const adminDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);
adminDb.collection('transactions').get().then(res => { console.log("OK", res.size); }).catch(console.error);
