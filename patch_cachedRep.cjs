const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(/const cachedRep = \(await idbGet<any\[\]>\('lkgs_reports'\)\) \|\| \[\];/g, "let cachedRep = (await idbGet<any[]>('lkgs_reports')) || [];\n          if (!Array.isArray(cachedRep)) cachedRep = [];");

fs.writeFileSync('src/App.tsx', code);
