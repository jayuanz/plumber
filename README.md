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
