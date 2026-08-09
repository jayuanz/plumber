import { Terminal } from '@xterm/xterm';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

const app = document.querySelector('#app');

let terminal;
let fitAddon;
let socket;
let resizeObserver;
let disposeTerminalInput;
let heartbeatTimer;
let reconnectTimer;
let reconnectRequested = false;

renderShell();
void bootstrap();

async function bootstrap() {
  const [user, authConfig] = await Promise.all([fetchMe(), fetchAuthConfig()]);
  if (user?.authenticated) {
    renderTerminal(user);
    await connectTerminal();
    return;
  }

  renderLogin(authConfig);
}

function renderShell() {
  app.innerHTML = `
    <main class="app-shell">
      <section class="terminal-frame" data-view="terminal" hidden>
        <header class="topbar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true"></span>
            <span>Plumber</span>
          </div>
          <div class="session-meta">
            <span class="status-dot" data-status-dot></span>
            <span data-status-text>Disconnected</span>
          </div>
          <div class="actions">
            <button class="icon-button" type="button" data-action="fit" title="Fit terminal" aria-label="Fit terminal">
              <span aria-hidden="true">⤢</span>
            </button>
            <button class="text-button" type="button" data-action="reconnect">Reconnect</button>
            <button class="text-button danger" type="button" data-action="logout">Logout</button>
          </div>
        </header>
        <div class="terminal-host" data-terminal-host></div>
      </section>

      <section class="login-view" data-view="login" hidden>
        <form class="login-panel" data-login-form>
          <div>
            <h1>Plumber</h1>
            <p>Sign in to open your terminal session.</p>
          </div>
          <label>
            <span>Username</span>
            <input name="username" autocomplete="username" required value="admin" />
          </label>
          <label data-password-field>
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" required autofocus />
          </label>
          <label data-totp-field hidden>
            <span>Authenticator code</span>
            <input
              name="totpCode"
              autocomplete="one-time-code"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="8"
              placeholder="6-digit code"
            />
          </label>
          <p class="form-error" data-login-error hidden></p>
          <button class="primary-button" type="submit">Sign in</button>
        </form>
      </section>
    </main>
  `;

  app.querySelector('[data-action="fit"]').addEventListener('click', fitTerminal);
  app.querySelector('[data-action="reconnect"]').addEventListener('click', async () => {
    reconnectRequested = true;
    await reconnectTerminal();
  });
  app.querySelector('[data-action="logout"]').addEventListener('click', logout);
}

function renderLogin(authConfig = defaultAuthConfig()) {
  showView('login');
  const form = app.querySelector('[data-login-form]');
  const error = app.querySelector('[data-login-error]');
  const passwordField = app.querySelector('[data-password-field]');
  const passwordInput = form.elements.password;
  const totpField = app.querySelector('[data-totp-field]');
  const totpInput = form.elements.totpCode;

  passwordField.hidden = !authConfig.requiresPassword;
  passwordInput.required = authConfig.requiresPassword;
  passwordInput.disabled = !authConfig.requiresPassword;
  totpField.hidden = !authConfig.requiresTotp;
  totpInput.required = authConfig.requiresTotp;
  totpInput.disabled = !authConfig.requiresTotp;
  totpInput.maxLength = authConfig.totpDigits || 6;
  totpInput.placeholder = `${authConfig.totpDigits || 6}-digit code`;

  if (!authConfig.requiresPassword && authConfig.requiresTotp) {
    totpInput.autofocus = true;
    totpInput.focus();
  } else {
    passwordInput.focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;

    const formData = new FormData(form);
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: formData.get('username'),
        password: authConfig.requiresPassword ? formData.get('password') : undefined,
        totpCode: authConfig.requiresTotp ? formData.get('totpCode') : undefined,
      }),
    });

    if (!response.ok) {
      const body = await safeJson(response);
      error.textContent = loginErrorText(body?.error);
      error.hidden = false;
      return;
    }

    renderTerminal(await response.json());
    await connectTerminal();
  });
}

function renderTerminal(user) {
  showView('terminal');

  if (!terminal) {
    terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      drawBoldTextInBrightColors: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      macOptionIsMeta: true,
      // On macOS, Option(⌥) + click-drag forces a selection even when the
      // active program (e.g. tmux with `set -g mouse on`) has grabbed mouse
      // reporting, so the selection reaches the browser clipboard.
      macOptionClickForcesSelection: true,
      minimumContrastRatio: 1,
      scrollback: 10000,
      theme: {
        background: '#0b0d10',
        foreground: '#e7edf3',
        cursor: '#f5c451',
        selectionBackground: '#265f78',
        black: '#111318',
        red: '#ff6b6b',
        green: '#63d471',
        yellow: '#f5c451',
        blue: '#65a8ff',
        magenta: '#d18aff',
        cyan: '#58d5d0',
        white: '#e7edf3',
        brightBlack: '#676f7d',
        brightRed: '#ff8585',
        brightGreen: '#8cea95',
        brightYellow: '#ffdc73',
        brightBlue: '#8bbfff',
        brightMagenta: '#e1a8ff',
        brightCyan: '#80e5df',
        brightWhite: '#ffffff',
      },
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    // Honor OSC 52 so a remote program (e.g. tmux copy-mode over SSH) can write
    // to / read from the local clipboard through the browser.
    terminal.loadAddon(new ClipboardAddon());
    terminal.open(app.querySelector('[data-terminal-host]'));
    bindClipboardShortcuts(terminal);
    terminal.focus();

    resizeObserver = new ResizeObserver(() => {
      fitTerminal();
      sendResize();
    });
    resizeObserver.observe(app.querySelector('[data-terminal-host]'));
  }

  terminal.writeln(`\x1b[36mSigned in as ${user.username || 'user'}.\x1b[0m`);
}

async function connectTerminal() {
  setStatus('connecting', 'Connecting');

  const ticketResponse = await fetch('/api/terminal-ticket', { method: 'POST' });
  if (!ticketResponse.ok) {
    setStatus('disconnected', 'Unauthorized');
    terminal?.writeln('\r\n\x1b[31mUnable to create terminal ticket. Please sign in again.\x1b[0m');
    return;
  }

  const { ticket } = await ticketResponse.json();
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/terminal`;
  socket = new WebSocket(wsUrl, ['plumber.terminal', `ticket.${ticket}`]);

  socket.addEventListener('open', () => {
    reconnectRequested = false;
    setStatus('connected', 'Connected');
    fitTerminal();
    sendResize();
    bindTerminalInput();
    startHeartbeat();
  });

  socket.addEventListener('message', (event) => {
    const message = parseSocketMessage(event.data);
    if (!message) {
      return;
    }

    if (message.type === 'ready') {
      terminal?.writeln(`\x1b[2mSession ${message.sessionId} · ${message.shell} · ${message.cwd}\x1b[0m\r\n`);
      return;
    }

    if (message.type === 'output') {
      terminal?.write(message.data);
      return;
    }

    if (message.type === 'exit') {
      terminal?.writeln(`\r\n\x1b[33mProcess exited with code ${message.exitCode ?? 'unknown'}.\x1b[0m`);
      return;
    }

    if (message.type === 'error') {
      terminal?.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`);
    }
  });

  socket.addEventListener('close', () => {
    unbindTerminalInput();
    stopHeartbeat();
    setStatus('disconnected', 'Disconnected');
    if (reconnectRequested) {
      return;
    }
    terminal?.writeln('\r\n\x1b[33mConnection closed. Use Reconnect to start a new shell.\x1b[0m');
  });

  socket.addEventListener('error', () => {
    setStatus('disconnected', 'Connection error');
  });
}

async function reconnectTerminal() {
  clearTimeout(reconnectTimer);
  stopHeartbeat();
  unbindTerminalInput();
  if (socket && socket.readyState <= WebSocket.OPEN) {
    socket.close();
  }

  terminal?.writeln('\r\n\x1b[36mReconnecting...\x1b[0m');
  reconnectTimer = setTimeout(() => {
    void connectTerminal();
  }, 200);
}

function bindTerminalInput() {
  unbindTerminalInput();
  disposeTerminalInput = terminal.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });
}

function unbindTerminalInput() {
  disposeTerminalInput?.dispose();
  disposeTerminalInput = null;
}

function bindClipboardShortcuts(term) {
  // Map the host's copy/paste shortcuts onto the terminal selection / PTY, so
  // they work even though xterm.js renders into a non-text canvas-like surface.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') {
      return true;
    }

    // ⌘ on macOS, Ctrl+Shift on Windows/Linux.
    const modifier = event.metaKey || (event.ctrlKey && event.shiftKey);

    if (modifier && event.key === 'c' && term.hasSelection()) {
      copyToClipboard(term.getSelection());
      return false; // don't also forward ^C to the shell
    }

    if (modifier && event.key === 'v') {
      pasteFromClipboard(term);
      return false; // don't let the browser paste into the helper textarea
    }

    return true;
  });
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy path.
  }

  // Legacy fallback for non-secure (plain-HTTP) contexts, where
  // navigator.clipboard is unavailable. Only covers visible-text copy.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch {
    // Ignore; nothing else we can do without a secure context.
  }
  textarea.remove();
}

async function pasteFromClipboard(term) {
  let text = '';
  try {
    text = (await navigator.clipboard?.readText?.()) ?? '';
  } catch {
    text = '';
  }
  if (text) {
    term.paste(text);
  }
}

function sendResize() {
  if (!terminal || !fitAddon || socket?.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      type: 'resize',
      cols: terminal.cols,
      rows: terminal.rows,
    }),
  );
}

function fitTerminal() {
  if (!terminal || !fitAddon) {
    return;
  }

  try {
    fitAddon.fit();
  } catch {
    // The terminal may not be visible during a view transition.
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }
  }, 25_000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = null;
}

async function logout() {
  stopHeartbeat();
  unbindTerminalInput();
  reconnectRequested = true;
  socket?.close();
  await fetch('/api/logout', { method: 'POST' });
  terminal?.dispose();
  resizeObserver?.disconnect();
  terminal = null;
  fitAddon = null;
  socket = null;
  resizeObserver = null;
  renderShell();
  renderLogin(await fetchAuthConfig());
}

async function fetchMe() {
  const response = await fetch('/api/me');
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function fetchAuthConfig() {
  const response = await fetch('/api/auth-config');
  if (!response.ok) {
    return defaultAuthConfig();
  }

  return response.json();
}

function defaultAuthConfig() {
  return {
    authMode: 'password',
    requiresPassword: true,
    requiresTotp: false,
    totpDigits: 6,
    totpPeriodSeconds: 30,
  };
}

function showView(name) {
  for (const view of app.querySelectorAll('[data-view]')) {
    view.hidden = view.dataset.view !== name;
  }
}

function setStatus(state, text) {
  const dot = app.querySelector('[data-status-dot]');
  const label = app.querySelector('[data-status-text]');
  if (!dot || !label) {
    return;
  }

  dot.dataset.state = state;
  label.textContent = text;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function parseSocketMessage(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function loginErrorText(error) {
  if (error === 'password_not_configured') {
    return 'Server password is not configured.';
  }

  if (error === 'totp_not_configured') {
    return 'Authenticator secret is not configured.';
  }

  if (error === 'origin_not_allowed') {
    return 'Request origin is not allowed.';
  }

  if (error === 'too_many_attempts') {
    return 'Too many failed attempts. Try again later.';
  }

  return 'Invalid username, password, or authenticator code.';
}
