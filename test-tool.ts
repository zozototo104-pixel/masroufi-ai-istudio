import { addTransaction, getBalance, queryTransactions } from './src/server/tools.ts';
import fs from 'fs';
const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
// I don't have a token. So I can't test it directly unless I somehow bypass auth.
console.log("Ready");
