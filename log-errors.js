import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(/console\.error\("Balance Error:", e\.message\);/g,
  'require("fs").appendFileSync("app-errors.log", "Balance Error: " + e.message + "\\n"); console.error("Balance Error:", e.message);');

code = code.replace(/console\.error\("Transactions Error:", e\.message\);/g,
  'require("fs").appendFileSync("app-errors.log", "Transactions Error: " + e.message + "\\n"); console.error("Transactions Error:", e.message);');

code = code.replace(/console\.error\("Reports Error:", e\.message\);/g,
  'require("fs").appendFileSync("app-errors.log", "Reports Error: " + e.message + "\\n"); console.error("Reports Error:", e.message);');

fs.writeFileSync('server.ts', code);
