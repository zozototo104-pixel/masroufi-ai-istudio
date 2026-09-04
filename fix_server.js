import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(/const result = await getBalance\(req\.user\.uid\);/g, 
  "const token = req.headers.authorization.split('Bearer ')[1];\n    const result = await getBalance({}, req.user.uid, token);");

code = code.replace(/const result = await queryTransactions\(\{ period: 'custom' \}, req\.user\.uid\);/g,
  "const token = req.headers.authorization.split('Bearer ')[1];\n    const result = await queryTransactions({ period: 'custom' }, req.user.uid, token);");

code = code.replace(/const result = await getReports\(req\.user\.uid\);/g,
  "const token = req.headers.authorization.split('Bearer ')[1];\n    const result = await getReports({}, req.user.uid, token);");

code = code.replace(/const result = await addTransaction\(txArgs, req\.user\.uid\);/g,
  "const token = req.headers.authorization.split('Bearer ')[1];\n      const result = await addTransaction(txArgs, req.user.uid, token);");

fs.writeFileSync('server.ts', code);
console.log("Fixed server.ts calls");
