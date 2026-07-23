const http = require('http');
const options = { hostname: '127.0.0.1', port: 3456, path: '/api/browse-folders', method: 'POST', headers: { 'Content-Type': 'application/json', 'Host': '127.0.0.1:3456' } };
const req = http.request(options, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { console.log('Status:', res.statusCode); console.log('Response:', d); }); });
req.on('error', e => console.error('Error:', e.message));
req.write(JSON.stringify({}));
req.end();
