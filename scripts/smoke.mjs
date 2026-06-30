import crypto from 'node:crypto';

import WebSocket from 'ws';

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const username = process.env.SMOKE_USERNAME || process.env.WEBTERM_USERNAME || 'admin';
const password = process.env.SMOKE_PASSWORD || process.env.WEBTERM_PASSWORD;
const totpSecretBase32 = process.env.SMOKE_TOTP_SECRET_BASE32 || process.env.WEBTERM_TOTP_SECRET_BASE32 || '';

if (!password && !totpSecretBase32) {
  console.error('Set SMOKE_PASSWORD/WEBTERM_PASSWORD or SMOKE_TOTP_SECRET_BASE32/WEBTERM_TOTP_SECRET_BASE32 before running smoke tests.');
  process.exit(1);
}

const loginResponse = await fetch(`${baseUrl}/api/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username,
    password,
    totpCode: totpSecretBase32 ? generateTotpCode(totpSecretBase32) : undefined,
  }),
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

function generateTotpCode(secretBase32) {
  const secret = decodeBase32(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(value).toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error('Invalid TOTP secret.');
  }

  let bits = '';
  for (const char of normalized) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}
