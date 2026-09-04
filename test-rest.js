import fs from 'fs';
const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
const projectId = firebaseConfig.projectId;
const databaseId = firebaseConfig.firestoreDatabaseId;

const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${databaseId}/documents/transactions`;

fetch(url).then(res => res.json()).then(console.log).catch(console.error);
