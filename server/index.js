import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as cookie from 'cookie';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const releaseRoot = process.env.PLUMBER_RELEASE_ROOT ? path.resolve(process.env.PLUMBER_RELEASE_ROOT) : '';
const projectRoot = path.resolve(__dirname, '..');
const clientDist = releaseRoot ? path.join(releaseRoot, 'web/dist') : path.resolve(__dirname, '../web/dist');

loadRuntimeEnv();

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  username: process.env.WEBTERM_USERNAME || 'admin',
  password: process.env.WEBTERM_PASSWORD || '',
  authMode: normalizeAuthMode(process.env.WEBTERM_AUTH_MODE, process.env.WEBTERM_TOTP_SECRET_BASE32),
  totpSecretBase32: process.env.WEBTERM_TOTP_SECRET_BASE32 || '',
  totpDigits: readPositiveIntegerEnv('WEBTERM_TOTP_DIGITS', 6),
  totpPeriodSeconds: readPositiveIntegerEnv('WEBTERM_TOTP_PERIOD_SECONDS', 30),
  totpWindow: readNonNegativeIntegerEnv('WEBTERM_TOTP_WINDOW', 1),
  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('base64url'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  allowNoOrigin: process.env.ALLOW_NO_ORIGIN === 'true',
  shell: process.env.WEBTERM_SHELL || process.env.SHELL || '/bin/bash',
  cwd: process.env.WEBTERM_CWD || os.homedir(),
  forceColor: process.env.WEBTERM_FORCE_COLOR !== 'false',
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  sessionTtlMs: readPositiveIntegerEnv('SESSION_TTL_MS', 8 * 60 * 60 * 1000),
  ticketTtlMs: readPositiveIntegerEnv('TICKET_TTL_MS', 30 * 1000),
  loginWindowMs: readPositiveIntegerEnv('LOGIN_WINDOW_MS', 15 * 60 * 1000),
  loginMaxAttempts: readPositiveIntegerEnv('LOGIN_MAX_ATTEMPTS', 8),
  maxTerminalSessions: readPositiveIntegerEnv('MAX_TERMINAL_SESSIONS', 4),
  maxTerminalSessionsPerUser: readPositiveIntegerEnv('MAX_TERMINAL_SESSIONS_PER_USER', 2),
  terminalIdleTimeoutMs: readPositiveIntegerEnv('TERMINAL_IDLE_TIMEOUT_MS', 30 * 60 * 1000),
  terminalMaxSessionMs: readPositiveIntegerEnv('TERMINAL_MAX_SESSION_MS', 8 * 60 * 60 * 1000),
  maxInputBytes: readPositiveIntegerEnv('MAX_INPUT_BYTES', 64 * 1024),
};

function loadRuntimeEnv() {
  const envFile = process.env.PLUMBER_ENV_FILE
    ? path.resolve(process.env.PLUMBER_ENV_FILE)
    : path.join(releaseRoot || projectRoot, '.env');
  const result = dotenv.config({ path: envFile });

  if (result.error && result.error.code !== 'ENOENT') {
    console.warn(`[plumber] Could not load env file at ${envFile}: ${result.error.message}`);
  }
}

if (!process.env.SESSION_SECRET) {
  console.warn('[plumber] SESSION_SECRET is not set. Existing sessions will be invalid after restart.');
} else if (process.env.SESSION_SECRET.length < 32) {
  console.warn('[plumber] SESSION_SECRET should be at least 32 characters in production.');
}

if (!config.password) {
  if (authRequiresPassword()) {
    console.warn('[plumber] WEBTERM_PASSWORD is not set. Password login is disabled until a password is configured.');
  }
} else if (config.password.length < 16) {
  console.warn('[plumber] WEBTERM_PASSWORD should be at least 16 characters in production.');
}

if (authRequiresTotp() && !config.totpSecretBase32) {
  console.warn('[plumber] WEBTERM_TOTP_SECRET_BASE32 is not set. TOTP login is disabled until a secret is configured.');
}

const SESSION_COOKIE = 'plumber_session';
const MAX_WS_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_COLS = 400;
const MAX_ROWS = 200;
const MIN_COLS = 20;
const MIN_ROWS = 5;

const sessions = new Map();
const terminalTickets = new Map();
const loginAttempts = new Map();
const activeTerminals = new Map();
const compareKey = crypto.randomBytes(32);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.cookieSecure
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        }
      : false,
  }),
);
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !isHttpOriginAllowed(req)) {
    res.status(403).json({ error: 'origin_not_allowed' });
    return;
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth-config', (_req, res) => {
  res.json(getPublicAuthConfig());
});

app.get('/api/me', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    username: session.username,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
});

app.post('/api/login', (req, res) => {
  if (authRequiresPassword() && !config.password) {
    res.status(503).json({ error: 'password_not_configured' });
    return;
  }

  if (authRequiresTotp() && !config.totpSecretBase32) {
    res.status(503).json({ error: 'totp_not_configured' });
    return;
  }

  const { username, password, totpCode } = req.body || {};
  if (typeof username !== 'string') {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }

  const loginKey = getLoginRateKey(req, username);
  const retryAfterSeconds = getLoginRetryAfterSeconds(loginKey);
  if (retryAfterSeconds > 0) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds });
    return;
  }

  if (username !== config.username || !validateLoginCredentials({ password, totpCode })) {
    recordFailedLogin(loginKey);
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }

  loginAttempts.delete(loginKey);
  const sessionId = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + config.sessionTtlMs;
  sessions.set(sessionId, { username, expiresAt });
  setSessionCookie(res, sessionId);
  res.json({ ok: true, username, expiresAt: new Date(expiresAt).toISOString() });
});

app.post('/api/logout', (req, res) => {
  const sessionId = getSessionIdFromRequest(req);
  if (sessionId) {
    sessions.delete(sessionId);
  }

  res.setHeader(
    'Set-Cookie',
    cookie.serialize(SESSION_COOKIE, '', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.cookieSecure,
      maxAge: 0,
    }),
  );
  res.json({ ok: true });
});

app.post('/api/terminal-ticket', (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const ticket = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + config.ticketTtlMs;
  terminalTickets.set(ticket, {
    username: session.username,
    expiresAt,
    remoteAddress: req.ip,
  });

  res.json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
});

if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.type('text/plain').send('Build the frontend first with: npm run build\n');
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: config.maxInputBytes * 2,
  handleProtocols(protocols) {
    return protocols.has('plumber.terminal') ? 'plumber.terminal' : false;
  },
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws/terminal') {
    socket.destroy();
    return;
  }

  if (!isWebSocketOriginAllowed(req)) {
    rejectUpgrade(socket, 403, 'Origin not allowed');
    return;
  }

  const ticket = getTicketFromWebSocketProtocol(req);
  const ticketData = consumeTerminalTicket(ticket);
  if (!ticketData) {
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }

  const capacity = getTerminalCapacity(ticketData.username);
  if (!capacity.allowed) {
    rejectUpgrade(socket, 429, capacity.reason);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, ticketData);
  });
});

wss.on('connection', (ws, req, ticketData) => {
  const sessionId = crypto.randomUUID();
  let terminal;
  let closed = false;
  let lastActivityAt = Date.now();
  const openedAt = lastActivityAt;

  try {
    terminal = pty.spawn(config.shell, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: config.cwd,
      env: buildTerminalEnv(),
    });
  } catch (error) {
    safeSend(ws, { type: 'error', message: `Failed to start shell: ${error.message}` });
    ws.close(1011, 'pty_start_failed');
    return;
  }

  console.info(
    `[plumber] terminal opened session=${sessionId} user=${ticketData.username} pid=${terminal.pid} ip=${getRemoteAddress(req)}`,
  );

  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastActivityAt > config.terminalIdleTimeoutMs) {
      closeSession('idle_timeout');
      return;
    }

    if (now - openedAt > config.terminalMaxSessionMs) {
      closeSession('max_session_time');
    }
  }, 30 * 1000);
  watchdog.unref();

  activeTerminals.set(sessionId, {
    username: ticketData.username,
    close: closeSession,
  });

  safeSend(ws, {
    type: 'ready',
    sessionId,
    shell: path.basename(config.shell),
    cwd: config.cwd,
  });

  terminal.onData((data) => {
    lastActivityAt = Date.now();
    if (!safeSend(ws, { type: 'output', data })) {
      closeSession('client_buffer_overflow');
    }
  });

  terminal.onExit(({ exitCode, signal }) => {
    safeSend(ws, { type: 'exit', exitCode, signal });
    closeSession('pty_exit');
  });

  ws.on('message', (raw) => {
    const message = parseMessage(raw);
    if (!message || typeof message.type !== 'string') {
      safeSend(ws, { type: 'error', message: 'Invalid message' });
      return;
    }

    if (message.type === 'input') {
      if (typeof message.data === 'string') {
        if (Buffer.byteLength(message.data, 'utf8') > config.maxInputBytes) {
          safeSend(ws, { type: 'error', message: 'Input message is too large' });
          closeSession('input_too_large');
          return;
        }
        lastActivityAt = Date.now();
        terminal.write(message.data);
      }
      return;
    }

    if (message.type === 'resize') {
      const cols = clampInteger(message.cols, MIN_COLS, MAX_COLS);
      const rows = clampInteger(message.rows, MIN_ROWS, MAX_ROWS);
      if (cols && rows) {
        lastActivityAt = Date.now();
        terminal.resize(cols, rows);
      }
      return;
    }

    if (message.type === 'ping') {
      safeSend(ws, { type: 'pong', ts: Date.now() });
    }
  });

  ws.on('close', () => closeSession('ws_close'));
  ws.on('error', () => closeSession('ws_error'));

  function closeSession(reason) {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(watchdog);
    activeTerminals.delete(sessionId);

    try {
      if (terminal) {
        terminal.kill();
      }
    } catch {
      // PTY may already be closed.
    }

    try {
      if (ws.readyState === ws.OPEN) {
        ws.close();
      }
    } catch {
      // WebSocket may already be closed.
    }

    console.info(`[plumber] terminal closed session=${sessionId} reason=${reason}`);
  }
});

setInterval(pruneExpiredState, 60 * 1000).unref();

server.listen(config.port, config.host, () => {
  console.info(`[plumber] listening on http://${config.host}:${config.port}`);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function setSessionCookie(res, sessionId) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(SESSION_COOKIE, signValue(sessionId), {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.cookieSecure,
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    }),
  );
}

function getSessionFromRequest(req) {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

function getSessionIdFromRequest(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  return unsignValue(cookies[SESSION_COOKIE]);
}

function consumeTerminalTicket(ticket) {
  if (!ticket) {
    return null;
  }

  const ticketData = terminalTickets.get(ticket);
  terminalTickets.delete(ticket);
  if (!ticketData || ticketData.expiresAt < Date.now()) {
    return null;
  }

  return ticketData;
}

function signValue(value) {
  const signature = crypto.createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
  return `${value}.${signature}`;
}

function unsignValue(signedValue) {
  if (!signedValue || typeof signedValue !== 'string') {
    return null;
  }

  const dotIndex = signedValue.lastIndexOf('.');
  if (dotIndex <= 0) {
    return null;
  }

  const value = signedValue.slice(0, dotIndex);
  const signature = signedValue.slice(dotIndex + 1);
  const expected = signValue(value).slice(dotIndex + 1);
  if (!safeEqual(signature, expected)) {
    return null;
  }

  return value;
}

function secureCompare(actual, expected) {
  const actualDigest = crypto.createHmac('sha256', compareKey).update(actual).digest();
  const expectedDigest = crypto.createHmac('sha256', compareKey).update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function validateLoginCredentials({ password, totpCode }) {
  if (authRequiresPassword() && (typeof password !== 'string' || !secureCompare(password, config.password))) {
    return false;
  }

  if (authRequiresTotp() && (typeof totpCode !== 'string' || !verifyTotpCode(totpCode))) {
    return false;
  }

  return true;
}

function getPublicAuthConfig() {
  return {
    authMode: config.authMode,
    requiresPassword: authRequiresPassword(),
    requiresTotp: authRequiresTotp(),
    totpDigits: config.totpDigits,
    totpPeriodSeconds: config.totpPeriodSeconds,
  };
}

function authRequiresPassword() {
  return config.authMode === 'password' || config.authMode === 'password_totp';
}

function authRequiresTotp() {
  return config.authMode === 'totp' || config.authMode === 'password_totp';
}

function verifyTotpCode(code) {
  const normalizedCode = String(code).replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${config.totpDigits}}$`).test(normalizedCode)) {
    return false;
  }

  const secret = decodeBase32(config.totpSecretBase32);
  if (!secret) {
    return false;
  }

  const nowCounter = Math.floor(Date.now() / 1000 / config.totpPeriodSeconds);
  for (let offset = -config.totpWindow; offset <= config.totpWindow; offset += 1) {
    const expected = generateTotp(secret, nowCounter + offset, config.totpDigits);
    if (safeEqual(normalizedCode, expected)) {
      return true;
    }
  }

  return false;
}

function generateTotp(secret, counter, digits) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const token = binary % 10 ** digits;
  return String(token).padStart(digits, '0');
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(value).toUpperCase().replace(/[\s=-]/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    return null;
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

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isHttpOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }

  return isAllowedOrigin(origin, req);
}

function isWebSocketOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return config.allowNoOrigin;
  }

  return isAllowedOrigin(origin, req);
}

function isAllowedOrigin(origin, req) {
  if (config.allowedOrigins.length > 0) {
    return config.allowedOrigins.includes(origin);
  }

  return origin === getRequestOrigin(req);
}

function getRequestOrigin(req) {
  const forwardedProto = config.trustProxy ? req.headers['x-forwarded-proto'] : '';
  const forwardedHost = config.trustProxy ? req.headers['x-forwarded-host'] : '';
  const proto = String(forwardedProto || (req.socket.encrypted ? 'https' : 'http'))
    .split(',')[0]
    .trim();
  const host = forwardedHost || req.headers.host;
  return `${proto}://${host}`;
}

function getTicketFromWebSocketProtocol(req) {
  const protocolHeader = req.headers['sec-websocket-protocol'];
  if (!protocolHeader) {
    return null;
  }

  return (
    protocolHeader
      .split(',')
      .map((value) => value.trim())
      .find((value) => value.startsWith('ticket.'))
      ?.slice('ticket.'.length) || null
  );
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(`HTTP/1.1 ${statusCode} ${http.STATUS_CODES[statusCode]}\r\nConnection: close\r\n\r\n${message}`);
  socket.destroy();
}

function safeSend(ws, message) {
  if (ws.readyState !== ws.OPEN) {
    return false;
  }

  if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    return false;
  }

  ws.send(JSON.stringify(message));
  return true;
}

function parseMessage(raw) {
  try {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampInteger(value, min, max) {
  if (!Number.isInteger(value)) {
    return null;
  }

  return Math.max(min, Math.min(max, value));
}

function buildTerminalEnv() {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'Plumber',
    TERM_PROGRAM_VERSION: '0.1.0',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
  };

  delete env.NO_COLOR;
  delete env.NODE_DISABLE_COLORS;

  if (config.forceColor) {
    env.FORCE_COLOR = '3';
    env.CLICOLOR = '1';
  }

  return env;
}

function getRemoteAddress(req) {
  const forwardedFor = config.trustProxy ? req.headers['x-forwarded-for'] : '';
  return String(forwardedFor || req.socket.remoteAddress || '').split(',')[0].trim();
}

function pruneExpiredState() {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(sessionId);
    }
  }

  for (const [ticket, ticketData] of terminalTickets) {
    if (ticketData.expiresAt < now) {
      terminalTickets.delete(ticket);
    }
  }

  for (const [loginKey, attempt] of loginAttempts) {
    if (attempt.resetAt < now && (!attempt.lockedUntil || attempt.lockedUntil < now)) {
      loginAttempts.delete(loginKey);
    }
  }
}

function getLoginRateKey(req, username) {
  const safeUsername = username.slice(0, 128).toLowerCase();
  return `${getRemoteAddress(req)}:${safeUsername}`;
}

function getLoginRetryAfterSeconds(loginKey) {
  const attempt = loginAttempts.get(loginKey);
  if (!attempt || !attempt.lockedUntil || attempt.lockedUntil <= Date.now()) {
    return 0;
  }

  return Math.ceil((attempt.lockedUntil - Date.now()) / 1000);
}

function recordFailedLogin(loginKey) {
  const now = Date.now();
  const existing = loginAttempts.get(loginKey);
  const attempt =
    existing && existing.resetAt > now
      ? existing
      : {
          count: 0,
          resetAt: now + config.loginWindowMs,
          lockedUntil: 0,
        };

  attempt.count += 1;
  if (attempt.count >= config.loginMaxAttempts) {
    attempt.lockedUntil = now + config.loginWindowMs;
  }

  loginAttempts.set(loginKey, attempt);
}

function getTerminalCapacity(username) {
  if (activeTerminals.size >= config.maxTerminalSessions) {
    return { allowed: false, reason: 'Too many active terminal sessions' };
  }

  let userSessions = 0;
  for (const terminal of activeTerminals.values()) {
    if (terminal.username === username) {
      userSessions += 1;
    }
  }

  if (userSessions >= config.maxTerminalSessionsPerUser) {
    return { allowed: false, reason: 'Too many active terminal sessions for this user' };
  }

  return { allowed: true };
}

function readPositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    console.warn(`[plumber] ${name}=${raw} is invalid; using ${fallback}`);
    return fallback;
  }

  return value;
}

function readNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    console.warn(`[plumber] ${name}=${raw} is invalid; using ${fallback}`);
    return fallback;
  }

  return value;
}

function normalizeAuthMode(value, totpSecretBase32) {
  if (!value) {
    return totpSecretBase32 ? 'password_totp' : 'password';
  }

  const normalized = String(value).toLowerCase().replace(/[-\s]/g, '_');
  if (['password', 'password_totp', 'totp'].includes(normalized)) {
    return normalized;
  }

  console.warn(`[plumber] WEBTERM_AUTH_MODE=${value} is invalid; using password`);
  return 'password';
}

function shutdown(signal) {
  console.info(`[plumber] received ${signal}; shutting down`);
  for (const [sessionId, terminal] of activeTerminals) {
    try {
      terminal.close('server_shutdown');
    } catch {
      activeTerminals.delete(sessionId);
    }
  }

  wss.close();
  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    console.warn('[plumber] graceful shutdown timed out');
    process.exit(1);
  }, 5000).unref();
}
