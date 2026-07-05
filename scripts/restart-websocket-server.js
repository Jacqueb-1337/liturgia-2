require('dotenv').config({ path: require('path').join(__dirname, '..', 'liturgia', 'relay-ws', '.env') });
const http = require('http');

const port = process.env.RELAY_PORT || 3001;
const url = `http://apiliturgia.jacqueb.me:${port}/restart`;

console.log('Sending restart command to WebSocket server...');
console.log('URL:', url);
console.log('');

const req = http.request(url, {
  method: 'POST',
  timeout: 5000
}, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    console.log('Response:', data);
  console.log('');
  console.log('Server should restart automatically if using PM2 or systemd.');
  console.log('If using cPanel Node.js, you need to restart it manually in cPanel.');
  console.log('');
  console.log('Wait 5 seconds, then run: node scripts/check-websocket-server.js');
});
});

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  console.log('');
  console.log('The server may already be restarting or not running.');
  process.exit(1);
});

req.end();
