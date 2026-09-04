import fs from 'fs';
let content = fs.readFileSync('firestore.rules', 'utf8');
content = content.replace("['cash', 'palPay']", "['cash', 'palPay', 'debt']");
fs.writeFileSync('firestore.rules', content);
