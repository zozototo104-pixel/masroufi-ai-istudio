const fs = require('fs');

// Patch App.tsx (remove setInterval)
let appContent = fs.readFileSync('src/App.tsx', 'utf-8');
appContent = appContent.replace('const interval = setInterval(fetchData, 10000);', '');
appContent = appContent.replace('clearInterval(interval);', '');
appContent = appContent.replace('const balRes = await fetch(\'/api/balance\', { headers });', 'const balRes = await fetch(\'/api/notifications\', { headers });');

// Actually wait, let's just do everything using child_process
