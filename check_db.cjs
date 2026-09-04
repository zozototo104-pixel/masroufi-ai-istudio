const admin = require('firebase-admin');
const config = require('./firebase-applet-config.json');

admin.initializeApp({
  projectId: config.projectId
});

const db = config.firestoreDatabaseId ? admin.firestore(config.firestoreDatabaseId) : admin.firestore();

async function check() {
  const users = await admin.auth().listUsers();
  if (users.users.length === 0) return console.log('No users');
  const uid = users.users[0].uid;
  console.log('UID:', uid);
  
  const txSnapshot = await db.collection('transactions').where('userId', '==', uid).get();
  let cash = 0, palPay = 0, debt = 0;
  txSnapshot.forEach(doc => {
    const tx = doc.data();
    const amount = Number(tx.amount) || 0;
    
    // simple logic clone
    const acc = String(tx.account || '').toLowerCase();
    let norm = (acc.includes('pal') || acc.includes('بال') || acc.includes('محفظ')) ? 'palPay' : (acc.includes('debt') || acc.includes('دين') || acc.includes('اجل')) ? 'debt' : 'cash';
    
    if (tx.type === 'expense') {
      if (norm === 'palPay') palPay -= amount;
      else if (norm === 'debt') debt += amount;
      else cash -= amount;
    } else if (tx.type === 'income') {
      if (norm === 'palPay') palPay += amount;
      else if (norm === 'debt') debt -= amount;
      else cash += amount;
    } else if (tx.type === 'transfer') {
      let fromAcc = String(tx.fromAccount || tx.account || '').toLowerCase();
      let toAcc = String(tx.toAccount || '').toLowerCase();
      let nFrom = (fromAcc.includes('pal') || fromAcc.includes('بال') || fromAcc.includes('محفظ')) ? 'palPay' : (fromAcc.includes('debt') || fromAcc.includes('دين') || fromAcc.includes('اجل')) ? 'debt' : 'cash';
      let nTo = (toAcc.includes('pal') || toAcc.includes('بال') || toAcc.includes('محفظ')) ? 'palPay' : (toAcc.includes('debt') || toAcc.includes('دين') || toAcc.includes('اجل')) ? 'debt' : 'cash';
      
      if (nFrom === 'palPay') palPay -= amount;
      else if (nFrom === 'debt') debt += amount;
      else cash -= amount;
      
      if (nTo === 'palPay') palPay += amount;
      else if (nTo === 'debt') debt -= amount;
      else cash += amount;
    }
  });
  console.log('Cash:', cash, 'PalPay:', palPay, 'Debt:', debt);
}

check().catch(console.error);
