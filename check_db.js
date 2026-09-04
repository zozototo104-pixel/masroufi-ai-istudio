import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'fs';

const config = JSON.parse(readFileSync('./firebase-applet-config.json', 'utf8'));

if (!getApps().length) {
  initializeApp({ projectId: config.projectId });
}

const db = config.firestoreDatabaseId ? getFirestore(config.firestoreDatabaseId) : getFirestore();

async function check() {
  
  const txSnapshot = await db.collection('transactions').get();
  
  const users = {};
  
  txSnapshot.forEach(doc => {
    const tx = doc.data();
    if (!users[tx.userId]) users[tx.userId] = { cash: 0, palPay: 0, debt: 0 };
    
    const amount = Number(tx.amount) || 0;
    
    const acc = String(tx.account || '').toLowerCase();
    let norm = (acc.includes('pal') || acc.includes('بال') || acc.includes('محفظ')) ? 'palPay' : (acc.includes('debt') || acc.includes('دين') || acc.includes('اجل')) ? 'debt' : 'cash';
    
    if (tx.type === 'expense') {
      if (norm === 'palPay') users[tx.userId].palPay -= amount;
      else if (norm === 'debt') users[tx.userId].debt += amount;
      else users[tx.userId].cash -= amount;
    } else if (tx.type === 'income') {
      if (norm === 'palPay') users[tx.userId].palPay += amount;
      else if (norm === 'debt') users[tx.userId].debt -= amount;
      else users[tx.userId].cash += amount;
    } else if (tx.type === 'transfer') {
      let fromAcc = String(tx.fromAccount || tx.account || '').toLowerCase();
      let toAcc = String(tx.toAccount || '').toLowerCase();
      let nFrom = (fromAcc.includes('pal') || fromAcc.includes('بال') || fromAcc.includes('محفظ')) ? 'palPay' : (fromAcc.includes('debt') || fromAcc.includes('دين') || fromAcc.includes('اجل')) ? 'debt' : 'cash';
      let nTo = (toAcc.includes('pal') || toAcc.includes('بال') || toAcc.includes('محفظ')) ? 'palPay' : (toAcc.includes('debt') || toAcc.includes('دين') || toAcc.includes('اجل')) ? 'debt' : 'cash';
      
      if (nFrom === 'palPay') users[tx.userId].palPay -= amount;
      else if (nFrom === 'debt') users[tx.userId].debt += amount;
      else users[tx.userId].cash -= amount;
      
      if (nTo === 'palPay') users[tx.userId].palPay += amount;
      else if (nTo === 'debt') users[tx.userId].debt -= amount;
      else users[tx.userId].cash += amount;
    }
  });
  console.log(users);
}

check().catch(console.error);
