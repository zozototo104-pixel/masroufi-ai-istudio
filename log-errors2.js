import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(/require\("fs"\)\.appendFileSync/g, 'fs.appendFileSync');
if (!code.includes("import fs from 'fs';")) {
  code = "import fs from 'fs';\n" + code;
}

fs.writeFileSync('server.ts', code);
