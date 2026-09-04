import http from 'http';
import https from 'https';

http.get({
  hostname: 'metadata.google.internal',
  path: '/computeMetadata/v1/instance/service-accounts/default/token',
  headers: { 'Metadata-Flavor': 'Google' }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const token = JSON.parse(data).access_token;
    https.get({
      hostname: 'firestore.googleapis.com',
      path: '/v1/projects/fundamental-dolphin-gzp2g/databases',
      headers: { 'Authorization': `Bearer ${token}` }
    }, (res2) => {
      let data2 = '';
      res2.on('data', chunk => data2 += chunk);
      res2.on('end', () => console.log(data2));
    });
  });
});
