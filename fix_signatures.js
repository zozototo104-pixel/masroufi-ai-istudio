import fs from 'fs';
let code = fs.readFileSync('src/server/tools.ts', 'utf8');

// Replace any missing args with args: any
code = code.replace(/export async function getBalance\(userId: string, token: string\)/g, "export async function getBalance(args: any, userId: string, token: string)");
code = code.replace(/export async function getReports\(userId: string, token: string\)/g, "export async function getReports(args: any, userId: string, token: string)");
code = code.replace(/export async function getRecentTransactions\(userId: string, token: string\)/g, "export async function getRecentTransactions(args: any, userId: string, token: string)");

fs.writeFileSync('src/server/tools.ts', code);
console.log("Fixed signatures!");
