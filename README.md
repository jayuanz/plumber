# Plumber

Plumber is a small PTY-backed web terminal intended for private cloud-server access. It uses HTTPS/WSS at the transport layer and a real pseudo terminal behind the WebSocket, so tools such as `ssh`, `tmux`, `vim`, `fzf`, Claude Code, and Codex can behave like they do in a normal terminal.

## Features

- Browser terminal built with xterm.js.
- Server-side PTY, not command-output polling.
- Password login with signed, HTTP-only session cookies.
- One-time short-lived WebSocket terminal tickets.
- Same-origin checks for HTTP and WebSocket requests.
- Origin allowlist support for reverse-proxy deployments.
- Terminal resize propagation.
- Login throttling and terminal session limits.
- Idle and absolute terminal session timeouts.
- Conservative security headers via Helmet.

## Quick Start

```bash
npm install
cp .env.example .env
```

Edit `.env` and set at least:

```bash
WEBTERM_PASSWORD=use-a-long-random-password
SESSION_SECRET=use-at-least-32-random-bytes
```

Then build and start:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:3000`.

Plumber loads `.env` from the project or release directory automatically. To use a different file, start with `PLUMBER_ENV_FILE=/path/to/plumber.env npm start`. A Python-style `.venv` directory is not loaded by npm; activate it separately before starting if you need one for other tools.

## Configuration

Important environment variables:

| Name | Default | Notes |
| --- | --- | --- |
| `WEBTERM_USERNAME` | `admin` | Single local account for this first version. |
| `WEBTERM_AUTH_MODE` | `password` | `password`, `password_totp`, or `totp`. |
| `WEBTERM_PASSWORD` | empty | Required before login works. Use a long random value. |
| `WEBTERM_TOTP_SECRET_BASE32` | empty | Authenticator app shared secret. Required for TOTP modes. |
| `WEBTERM_TOTP_DIGITS` | `6` | Authenticator code length. Keep `6` for normal apps. |
| `WEBTERM_TOTP_PERIOD_SECONDS` | `30` | Authenticator code rotation period. Keep `30` for normal apps. |
| `WEBTERM_TOTP_WINDOW` | `1` | Accepts one previous/current/next code window to tolerate clock skew. |
| `SESSION_SECRET` | random on boot | Required in production so sessions survive restarts. |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS. Enables secure cookies and HSTS. |
| `TRUST_PROXY` | `false` | Set `true` behind Nginx/Caddy/load balancer. |
| `ALLOWED_ORIGINS` | same-origin only | Comma-separated list, for example `https://terminal.example.com`. |
| `WEBTERM_SHELL` | `$SHELL` or `/bin/bash` | Shell spawned by the PTY. |
| `WEBTERM_CWD` | server home dir | Initial working directory for terminal sessions. |
| `WEBTERM_FORCE_COLOR` | `true` | Clears inherited `NO_COLOR` and advertises truecolor support to TUI tools. |
| `LOGIN_MAX_ATTEMPTS` | `8` | Failed login attempts per IP/user window. |
| `LOGIN_WINDOW_MS` | `900000` | Login throttle window. |
| `MAX_TERMINAL_SESSIONS` | `4` | Global active PTY cap. |
| `MAX_TERMINAL_SESSIONS_PER_USER` | `2` | Active PTY cap per username. |
| `TERMINAL_IDLE_TIMEOUT_MS` | `1800000` | Closes sessions after no terminal activity. |
| `TERMINAL_MAX_SESSION_MS` | `28800000` | Absolute max lifetime for a PTY session. |
| `MAX_INPUT_BYTES` | `65536` | Max bytes for a single terminal input message. |

## Authenticator Codes

Plumber supports TOTP codes from apps such as Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden, and iCloud Passwords.

Generate a new TOTP secret:

```bash
npm run totp:generate
```

The command prints:

- A Base32 secret you can paste into an authenticator app manually.
- An `otpauth://` URI that many password managers can import.
- Recommended `.env` lines.

Recommended production mode is password plus authenticator code:

```bash
WEBTERM_AUTH_MODE=password_totp
WEBTERM_PASSWORD=use-a-long-random-password
WEBTERM_TOTP_SECRET_BASE32=PASTE_GENERATED_SECRET_HERE
```

If you really want the login form to use only the authenticator code:

```bash
WEBTERM_AUTH_MODE=totp
WEBTERM_TOTP_SECRET_BASE32=PASTE_GENERATED_SECRET_HERE
```

`totp` mode is convenient, but `password_totp` is safer because it keeps two independent factors.

## Running TUI AI Tools Through SSH

The recommended pattern is to keep long-running work inside `tmux` on the target machine:

```bash
ssh -t user@server-b 'tmux new -A -s ai'
```

Inside that `tmux` session you can run tools such as:

```bash
claude
codex
vim
fzf
```

If you see terminal rendering issues, check the target server:

```bash
stty size
echo $TERM
locale
```

Recommended environment:

```bash
export TERM=xterm-256color
export COLORTERM=truecolor
unset NO_COLOR
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
```

### Copy & paste

| Action | Shortcut |
| --- | --- |
| Copy selection | `⌘C` (mac) / `Ctrl+Shift+C` (others) |
| Paste from clipboard | `⌘V` (mac) / `Ctrl+Shift+V` (others) |
| Force-select when the program grabbed the mouse (e.g. `tmux` with `set -g mouse on`) | `Option`+drag (mac) / `Shift`+drag |

**Copying from a remote `tmux` over SSH.** Text that lives inside the remote
`tmux` (copy-mode, other panes, scrollback that has scrolled off the Plumber
viewport) is not part of the local terminal buffer, so the selection shortcuts
above can't reach it. Plumber bridges this with the **OSC 52** escape sequence:
when the remote `tmux` copies, it emits OSC 52, which Plumber writes to your
local clipboard. Tell the remote `tmux` to emit it:

```bash
# ~/.tmux.conf on the remote host
set -s set-clipboard on            # tmux 3.2+ (older releases: set -g set-clipboard on)
set -ag terminal-features ',*:clipboard'
```

Then copy as usual inside `tmux` (e.g. `prefix` + `[` to enter copy-mode, select,
`Enter`) and the text lands in your local clipboard.

> **HTTPS required.** Clipboard access needs a *secure context* — HTTPS or
> `localhost`. Plumber itself serves HTTP, so access it through the TLS
> terminating reverse proxy (see [Production Deployment](#production-deployment))
> or over an SSH tunnel to `127.0.0.1`. Over plain `http://<host>` the
> OSC 52 copy and paste paths silently no-op (visible-text copy still works via a
> legacy fallback).

## Production Deployment

Run Plumber behind a TLS-terminating reverse proxy such as Nginx, Caddy, or a cloud load balancer. In production set:

```bash
COOKIE_SECURE=true
TRUST_PROXY=true
ALLOWED_ORIGINS=https://terminal.example.com
HOST=127.0.0.1
PORT=3000
```

An Nginx example is available at `deploy/nginx.conf`. The important parts are HTTPS, HSTS, and WebSocket upgrade forwarding:

```nginx
server {
    listen 443 ssl http2;
    server_name terminal.example.com;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location /ws/terminal {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
```

### Docker

The included Docker setup runs the app as an unprivileged `plumber` user and binds the container to localhost on the host:

```bash
cp .env.example .env
docker compose up --build -d
```

Keep Nginx/Caddy in front of `127.0.0.1:3000` for public access.

### systemd

For a non-container server install, copy the app to `/opt/plumber`, create a low-privilege `plumber` system user, put production env vars in `/etc/plumber.env`, then install `deploy/plumber.service`.

```bash
sudo useradd --create-home --shell /bin/bash plumber
sudo cp deploy/plumber.service /etc/systemd/system/plumber.service
sudo systemctl daemon-reload
sudo systemctl enable --now plumber
```

## Obfuscated Executable Release

Build a local obfuscated release package:

```bash
npm run release:obfuscated
```

On macOS arm64 this creates:

```text
release/plumber-macos-arm64/
├── plumber          # executable launcher
├── app/server.mjs   # obfuscated server bundle
├── app/node_modules # native node-pty sidecar
└── web/dist         # obfuscated frontend assets
```

Run it:

```bash
cd release/plumber-macos-arm64
WEBTERM_PASSWORD=change-this-long-random-password \
SESSION_SECRET=change-this-to-at-least-32-random-bytes \
HOST=127.0.0.1 \
PORT=3000 \
./plumber
```

The executable is generated with Node SEA, but Plumber still ships `app/` as a sidecar because `node-pty` is a native addon and must be loaded from disk. Keep the whole release directory together when copying it to another machine.

### Linux build

The `plumber-linux-x64/` layout mirrors the macOS one (`plumber` executable, `app/server.mjs`, `app/node_modules`, `web/dist`).

Recommended: build in a container so the binary is reproducible and links against an older glibc baseline (Debian bullseye, glibc 2.31) for broad distro compatibility. This works from any host with Docker, including macOS:

```bash
npm run release:linux
# output: release/plumber-linux-x64/
```

Alternatively, build natively on a Linux machine. `node-pty` compiles from source on install, so the build host needs a C/C++ toolchain first:

```bash
sudo apt-get install -y python3 build-essential
npm ci
npm run release:obfuscated   # produces release/plumber-linux-x64/
```

Run it on the target Linux host:

```bash
cd plumber-linux-x64
WEBTERM_PASSWORD=change-this-long-random-password \
SESSION_SECRET=change-this-to-at-least-32-random-bytes \
HOST=127.0.0.1 \
PORT=3000 \
./plumber
```

A native build links against the build host's glibc, so a binary built on a newer distribution may not run on an older one. Prefer `npm run release:linux` (or a CI runner with an old glibc) when you need to distribute widely.

## Security Notes

Use `wss://` in production. Extra browser-side encryption is intentionally not implemented because TLS already provides the browser-to-server transport encryption, and JavaScript-delivered application encryption does not defend against a trusted HTTPS inspection proxy that can rewrite the page.

For internet-facing use, add more controls around this service:

- MFA or SSO in front of Plumber.
- IP allowlists, VPN, or zero-trust access.
- A dedicated low-privilege system user.
- Separate users or containers for different operators.
- Logins and terminal session lifecycle audit.
- SSH host key verification when connecting onward to other servers.
- No terminal byte-stream logging unless you have an explicit audit policy.
- Regular OS and npm dependency updates.

Plumber currently stores sessions and terminal tickets in memory. Restarting the service invalidates active sessions, which is a useful default for this first version.
