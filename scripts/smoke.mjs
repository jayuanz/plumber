import WebSocket from 'ws';

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const username = process.env.SMOKE_USERNAME || process.env.WEBTERM_USERNAME || 'admin';
const password = process.env.SMOKE_PASSWORD || process.env.WEBTERM_PASSWORD;

if (!password) {
  console.error('Set SMOKE_PASSWORD or WEBTERM_PASSWORD before running smoke tests.');
  process.exit(1);
}

const loginResponse = await fetch(`${baseUrl}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

if (!loginResponse.ok) {
  throw new Error(`Login failed: ${loginResponse.status} ${await loginResponse.text()}`);
}

const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
if (!sessionCookie) {
  throw new Error('Login response did not include a session cookie.');
}

const ticketResponse = await fetch(`${baseUrl}/api/terminal-ticket`, {
  method: 'POST',
  headers: { Cookie: sessionCookie },
});

if (!ticketResponse.ok) {
  throw new Error(`Ticket request failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
}

const { ticket } = await ticketResponse.json();
const wsUrl = baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/ws/terminal';
const socket = new WebSocket(wsUrl, ['plumber.terminal', `ticket.${ticket}`], {
  headers: { Origin: baseUrl },
});

let output = '';
let sawExpectedOutput = false;
let opened = false;

socket.on('open', () => {
  opened = true;
});

socket.on('message', (data) => {
  const message = JSON.parse(data.toString('utf8'));

  if (message.type === 'ready') {
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    socket.send(JSON.stringify({ type: 'input', data: 'printf "PLUMBER_SMOKE_OK\\n"; exit\r' }));
    return;
  }

  if (message.type === 'output') {
    output += message.data;
    sawExpectedOutput = output.includes('PLUMBER_SMOKE_OK');
    return;
  }

  if (message.type === 'exit') {
    socket.close();
  }
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error(`Timed out waiting for PTY output. Output so far: ${JSON.stringify(output)}`));
  }, 8000);

  socket.on('unexpected-response', (_request, response) => {
    clearTimeout(timeout);
    reject(new Error(`WebSocket upgrade rejected with HTTP ${response.statusCode}`));
  });
  socket.on('close', () => {
    clearTimeout(timeout);
    resolve();
  });
  socket.on('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

if (!opened) {
  throw new Error('WebSocket closed before opening.');
}

if (!sawExpectedOutput) {
  throw new Error(`Did not observe expected PTY output. Output: ${JSON.stringify(output)}`);
}

console.log('Smoke test passed.');
