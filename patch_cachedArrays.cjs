const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(/const cachedTx = \(await idbGet<any\[\]>\('lkgs_transactions'\)\) \|\| \[\];/g, "let cachedTx = (await idbGet<any[]>('lkgs_transactions')) || [];\n          if (!Array.isArray(cachedTx)) cachedTx = [];");
code = code.replace(/const cachedCom = \(await idbGet<any\[\]>\('lkgs_commitments'\)\) \|\| \[\];/g, "let cachedCom = (await idbGet<any[]>('lkgs_commitments')) || [];\n          if (!Array.isArray(cachedCom)) cachedCom = [];");
code = code.replace(/const cachedOps = \(await idbGet<any\[\]>\('masrofi_pending_ops'\)\) \|\| \[\];/g, "let cachedOps = (await idbGet<any[]>('masrofi_pending_ops')) || [];\n          if (!Array.isArray(cachedOps)) cachedOps = [];");

fs.writeFileSync('src/App.tsx', code);
