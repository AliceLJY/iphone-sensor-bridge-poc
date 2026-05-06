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

## GitHub

This repo has no remote configured yet. After GitHub auth is available, add the remote and push:

```sh
git remote add origin <repo-url>
git push -u origin main
```
