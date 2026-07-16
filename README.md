# iPhone Sensor Bridge PoC

A zero-dependency Node.js bridge for sending photos, files, and text from a phone browser to a Mac inbox over a trusted LAN or Tailscale path.

## Security model

- `GET /` is an unauthenticated application shell. It contains neither the server token nor protected inbox data.
- `GET /api/health` is public and returns only service status and version.
- All other `/api/*` routes require `Authorization: Bearer <token>` when a token is configured.
- The former `x-bridge-token` header is no longer accepted.
- If any listen address is not loopback, startup is refused unless a Bearer-safe token of at least 32 characters is supplied through `BRIDGE_TOKEN` or `BRIDGE_TOKEN_FILE`. There is no tracked or predictable default token.
- The browser asks the user for the token and keeps it only in that tab's `sessionStorage`. It is not placed in the URL, HTML, or server-generated JavaScript.
- `X-Forwarded-For` is ignored by default. Set `TRUST_PROXY=true` only behind a trusted reverse proxy that overwrites that header.

Tailscale and the Bearer token cover different boundaries: Tailscale controls which devices can reach the HTTP service, while the token controls which requests can read inbox metadata or deliver content. Do not expose this server directly to the public internet. A direct LAN connection is plain HTTP, so use only a trusted LAN or a Tailscale route.

## Requirements

- Node.js 18 or newer
- No external npm dependencies

## Local loopback run

Loopback-only mode may run without a token:

```sh
npm start
```

The defaults are `127.0.0.1:8765` and `~/Desktop/iphone-sensor-inbox`.

## LAN or Tailscale run

Generate a high-entropy token locally and store it outside Git in a private file:

```sh
mkdir -p "$HOME/.config/iphone-sensor-bridge-poc"
chmod 700 "$HOME/.config/iphone-sensor-bridge-poc"
umask 077
openssl rand -hex 32 > "$HOME/.config/iphone-sensor-bridge-poc/token"
chmod 600 "$HOME/.config/iphone-sensor-bridge-poc/token"

cp .env.example .env
chmod 600 .env
```

Edit `.env`, set `HOSTS` to the required non-loopback address, and set `BRIDGE_TOKEN_FILE=$HOME/.config/iphone-sensor-bridge-poc/token`. Prefer the Mac's exact Tailscale address; use `0.0.0.0` only when you intentionally want the trusted LAN to reach the service. Load the local environment before starting:

```sh
set -a
. ./.env
set +a
npm start
```

Open the LAN or Tailscale URL on the phone, enter the same token, and connect. Closing the browser tab session clears its stored token.

## LaunchAgent installation

The tracked plist and installed LaunchAgent are both secret-free. The installer asks for the token with hidden input, stores it in `~/.config/iphone-sensor-bridge-poc/token` under a mode-`700` directory with file mode `600`, and restarts the LaunchAgent. The server refuses symlinks, wrong ownership, weak permissions, and malformed values:

```sh
npm run launchd:install
```

For non-interactive use, pass `BRIDGE_TOKEN` from a local secret store in the process environment. Optionally set `BRIDGE_LISTEN_HOSTS` to install an exact Tailscale or LAN listen address instead of the plist template default. The installer never prints the token or places it in a process argument. Running the installer changes the live LaunchAgent, so do not run it during a code-only review.

## Configuration

- `HOSTS`: comma-separated listen addresses; defaults to `127.0.0.1`.
- `PORT`: defaults to `8765`.
- `INBOX`: destination directory; defaults to `~/Desktop/iphone-sensor-inbox`.
- `BRIDGE_TOKEN`: direct token input; at least 32 characters when any `HOSTS` entry is non-loopback.
- `BRIDGE_TOKEN_FILE`: preferred launchd token source; must be a user-owned regular file with mode `600`.
- `MAX_BODY`: upload limit in bytes; defaults to 200 MiB.
- `TRUST_PROXY`: defaults to false; enable only for a trusted header-overwriting proxy.

## Verification

```sh
npm run check
npm test
curl -s http://127.0.0.1:8765/api/health
```

Protected API example:

```sh
curl -H 'Authorization: Bearer <token-from-local-secret-store>' \
  http://127.0.0.1:8765/api/items
```

CI runs the syntax and behavior tests on Node.js 18, 20, and 22.

## GitHub remote

This clone's `origin` is `git@github.com:AliceLJY/iphone-sensor-bridge-poc.git`, corresponding to [AliceLJY/iphone-sensor-bridge-poc](https://github.com/AliceLJY/iphone-sensor-bridge-poc).

## Why this exists

AirDrop does not cover non-Apple phones or a target Mac that is physically elsewhere. This bridge keeps the original flow simple: open the Mac's trusted LAN or Tailscale URL on the phone, authenticate in the browser, upload, and find the result in the Mac inbox without an iCloud, messaging-app, or cloud-drive round trip.
