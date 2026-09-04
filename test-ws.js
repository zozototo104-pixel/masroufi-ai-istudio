const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3000/live');
ws.on('open', () => { console.log('connected'); ws.close(); });
ws.on('error', (e) => { console.error('error', e); });
ws.on('close', () => { console.log('closed'); });
