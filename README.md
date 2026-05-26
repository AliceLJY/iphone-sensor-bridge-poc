# iPhone Sensor Bridge PoC

Local prototype for sending photos and files from a phone browser into a Mac inbox.

## Current State

- `server.js` is the restored Codex-generated PoC server.
- Uploads are written to `~/Desktop/iphone-sensor-inbox-v2` when started through `npm start`.
- The HTTP server listens on port `8765`.
- No external npm dependencies are required.

## Run

```sh
npm start
```

Then open the printed local or Tailscale-served URL from the phone.

## Verify

```sh
npm run check
curl -s http://127.0.0.1:8765/api/health
```

## Run On Mac Mini After Reboot

On the Mac mini:

```sh
npm run launchd:install
```

This installs `com.alice.iphone-sensor-bridge-poc` as a user LaunchAgent.

## Status

PoC — runs on the Mac mini as `com.alice.iphone-sensor-bridge-poc` LaunchAgent.
Not under active development; works for the original use cases (see below).

## Why this exists

AirDrop has two gaps this bridge fills:

1. **Non-Apple phones / borrowed devices** — AirDrop only works between Apple devices logged into iCloud. A browser-based drop works from any device that can open a URL.
2. **The target Mac isn't physically nearby** — AirDrop requires Bluetooth/Wi-Fi proximity. My Mac mini lives at home; when I'm out and want to drop a photo straight to its `~/Desktop` (so future-me at the desk can pick it up), AirDrop can't reach it but Tailscale can.

So: open Tailscale URL on phone → upload → file lands on the target Mac's desktop. No iCloud round-trip, no cables, works across vendors.
