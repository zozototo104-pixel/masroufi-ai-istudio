import fs from 'fs';
let code = fs.readFileSync('src/server/tools.ts', 'utf8');

code = code.replace("import { adminDb } from './firebaseAdmin';", "import { getDb } from './fakeDb';");

const funcRegex = /export async function ([a-zA-Z0-9_]+)\(args: any, userId: string\)\s*\{/g;
code = code.replace(funcRegex, (match, p1) => {
  return `export async function ${p1}(args: any, userId: string, token: string) {\n  const adminDb = getDb(token);`;
});

const funcRegex2 = /export async function ([a-zA-Z0-9_]+)\(userId: string\)\s*\{/g;
code = code.replace(funcRegex2, (match, p1) => {
  return `export async function ${p1}(userId: string, token: string) {\n  const adminDb = getDb(token);`;
});

code = code.replace(/Record<string, \(args: any, userId: string\) => Promise<any>>/g, "Record<string, (args: any, userId: string, token: string) => Promise<any>>");

fs.writeFileSync('src/server/tools.ts', code);
console.log("Rewritten!");
