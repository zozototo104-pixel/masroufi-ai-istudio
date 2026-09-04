import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

const firebaseConfig = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));

const app = initializeApp({
  projectId: firebaseConfig.projectId
});
const adminDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);

adminDb.collection('transactions').limit(1).get()
  .then(() => console.log('Admin SDK works with databaseId!'))
  .catch(e => console.error('Admin SDK failed:', e.message));
