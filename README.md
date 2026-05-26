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
Not under active development; works for the original use case (iPhone Safari → Mac inbox over LAN/Tailscale).
