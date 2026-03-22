const http = require('http');

const url = 'http://apiliturgia.jacqueb.me:3001/diag';

console.log('Checking WebSocket server diagnostics...');
console.log('URL:', url);
console.log('');

http.get(url, (res) => {
  let data = '';
  
  res.on('data', (chunk) => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      console.log('=== WebSocket Server Diagnostics ===\n');
      console.log(JSON.stringify(result, null, 2));
      console.log('');
      
      if (result.checks) {
        console.log('=== Summary ===');
        console.log('Database pool:', result.checks.db_pool);
        console.log('Database connection:', result.checks.db_connection);
        console.log('auth_tokens table:', result.checks.auth_tokens_table);
        console.log('relay_sessions table:', result.checks.relay_sessions_table);
        console.log('auth_tokens count:', result.checks.auth_tokens_count);
        console.log('');
        console.log('Environment:');
        console.log('  DB_HOST:', result.checks.env.DB_HOST);
        console.log('  DB_USER:', result.checks.env.DB_USER);
        console.log('  DB_NAME:', result.checks.env.DB_NAME);
        console.log('  DB_PASS:', result.checks.env.DB_PASS);
      }
    } catch (err) {
      console.error('Failed to parse JSON:', err.message);
      console.log('Raw response:', data);
    }
  });
}).on('error', (err) => {
  console.error('Request failed:', err.message);
  console.log('');
  console.log('Possible issues:');
  console.log('- Server is not running');
  console.log('- Port 3001 is blocked');
  console.log('- URL is incorrect');
  process.exit(1);
});
