import fs from 'fs';
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  /app\.get\("\/api\/balance", authMiddleware, async \(req: any, res: any\) => \{([\s\S]*?res\.json\(\{ \.\.\.result, notifications \}\);\s*)\};/g,
  `app.get("/api/balance", authMiddleware, async (req: any, res: any) => {
    try {
$1    } catch (e: any) {
      console.error("Balance Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });`
);

code = code.replace(
  /app\.get\("\/api\/transactions", authMiddleware, async \(req: any, res: any\) => \{([\s\S]*?res\.json\(result\);\s*)\};/g,
  `app.get("/api/transactions", authMiddleware, async (req: any, res: any) => {
    try {
$1    } catch (e: any) {
      console.error("Transactions Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });`
);

code = code.replace(
  /app\.get\("\/api\/reports", authMiddleware, async \(req: any, res: any\) => \{([\s\S]*?res\.json\(\{ reports: result \}\);\s*)\};/g,
  `app.get("/api/reports", authMiddleware, async (req: any, res: any) => {
    try {
$1    } catch (e: any) {
      console.error("Reports Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  });`
);

fs.writeFileSync('server.ts', code);
