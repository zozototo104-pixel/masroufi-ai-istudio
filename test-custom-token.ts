import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from './firebase-applet-config.json';
const app = initializeApp({ projectId: firebaseConfig.projectId });
getAuth(app).createCustomToken('test-uid').then(token => console.log("OK Token:", token.substring(0, 20) + '...')).catch(console.error);
