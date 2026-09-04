import fs from 'fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';

const firebaseConfig = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

signInAnonymously(auth).then(async (userCredential) => {
  const token = await userCredential.user.getIdToken();
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;
  
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'transactions' }],
      limit: { value: 1 }
    }
  };

  const res = await fetch(`${baseUrl}:runQuery?key=${firebaseConfig.apiKey}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  
  const json = await res.json();
  console.log("Response:", JSON.stringify(json, null, 2));
  process.exit(0);
}).catch(e => {
  console.error("Auth failed", e);
  process.exit(1);
});
