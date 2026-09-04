import fs from 'fs';
let code = fs.readFileSync('src/server/tools.ts', 'utf8');

code = code.replace(/category: args\.category \|\| null,/g, "category: args.category || 'غير مصنف',");
code = code.replace(/subcategory: args\.subcategory \|\| null,/g, "subcategory: args.subcategory || '',");
code = code.replace(/merchant: args\.merchant \|\| null,/g, "merchant: args.merchant || '',");
code = code.replace(/notes: args\.notes \|\| null,/g, "notes: args.notes || '',");
code = code.replace(/necessity: args\.necessity \|\| null,/g, "necessity: args.necessity || '',");

// Also let's fix the getBalance calls AGAIN to be sure they have the token!
// I saw them earlier and I didn't actually fix them!
code = code.replace(/const balances = await getBalance\(userId\);/g, "const balances = await getBalance({}, userId, token);");

fs.writeFileSync('src/server/tools.ts', code);
