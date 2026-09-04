import { getFirestore } from 'firebase-admin/firestore';
import { initializeApp } from 'firebase-admin/app';
import config from './firebase-applet-config.json';
initializeApp({ projectId: config.projectId });
const db = config.firestoreDatabaseId ? getFirestore(config.firestoreDatabaseId) : getFirestore();
async function run() {
  const docs = await db.collection('transactions').orderBy('createdAt', 'desc').limit(10).get();
  docs.forEach(d => console.log(d.data()));
}
run();
