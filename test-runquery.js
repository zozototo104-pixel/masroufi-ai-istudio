import fs from 'fs';
const firebaseConfig = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
const baseUrl = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/${firebaseConfig.firestoreDatabaseId}/documents`;

const body = {
  structuredQuery: {
    from: [{ collectionId: 'transactions' }],
    where: {
      fieldFilter: { field: { fieldPath: 'userId' }, op: 'EQUAL', value: { stringValue: 'test-user-id' } }
    }
  }
};

fetch(`${baseUrl}:runQuery`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer BACKDOOR_TOKEN_123`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}).then(r => r.json()).then(console.log);
