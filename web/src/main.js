import { Terminal } from '@xterm/xterm';
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
  const user = await fetchMe();
  if (user?.authenticated) {
    renderTerminal(user);
    await connectTerminal();
    return;
  }

  renderLogin();
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
          <label>
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" required autofocus />
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

function renderLogin() {
  showView('login');
  const form = app.querySelector('[data-login-form]');
  const error = app.querySelector('[data-login-error]');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;

    const formData = new FormData(form);
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: formData.get('username'),
        password: formData.get('password'),
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
    terminal.open(app.querySelector('[data-terminal-host]'));
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
  renderLogin();
}

async function fetchMe() {
  const response = await fetch('/api/me');
  if (!response.ok) {
    return null;
  }
  return response.json();
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

  if (error === 'origin_not_allowed') {
    return 'Request origin is not allowed.';
  }

  return 'Invalid username or password.';
}
