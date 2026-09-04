const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

// Replace the static "الديون" label and {debt} with dynamic ones
code = code.replace(
  /<p className="text-rose-400 text-xs mb-1">الديون<\/p>\s*<p className="font-semibold text-lg text-rose-400">\{debt\} ₪<\/p>/g,
  `<p className={\`text-xs mb-1 \${debt < 0 ? 'text-emerald-400' : 'text-rose-400'}\`}>{debt < 0 ? 'رصيد دائن (لك)' : 'الديون'}</p>
                  <p className={\`font-semibold text-lg \${debt < 0 ? 'text-emerald-400' : 'text-rose-400'}\`}>{Math.abs(debt)} ₪</p>`
);

fs.writeFileSync('src/App.tsx', code);
