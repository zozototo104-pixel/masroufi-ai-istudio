import http from 'http';
setTimeout(() => {
  http.get({
    hostname: 'localhost',
    port: 3000,
    path: '/api/balance',
    headers: { 'Authorization': 'Bearer BACKDOOR_TOKEN_123' }
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => console.log('Response:', res.statusCode, data));
  }).on('error', err => console.log('Error:', err));
}, 2000);
