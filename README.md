# AutoChat

AutoChat is a Messenger-only automation tool for scripted conversations across two Chrome profiles.

The production runtime is:

1. A local Node.js server on `localhost:3000`
2. A Chrome Manifest V3 extension installed in two different Chrome profiles
3. A WebSocket connection from each profile to the server
4. Chrome DevTools Protocol input for live Messenger sending

There is no fake chat page, no polling loop, and no test mode in this build.

## Architecture

- The server owns the script state and dispatches one step at a time.
- Each Chrome profile connects to the server over WebSocket and registers as profile `A` or `B`.
- When the next step belongs to a profile, the server pushes it to that profile only.
- The extension finds a Messenger tab in that profile and uses the Chrome debugger API to:
  - focus the tab
  - focus the message editor
  - clear existing text
  - insert the outgoing message
  - press Enter
- The extension reports success or failure back to the server over WebSocket.

## Folder Structure

```text
auto-message-sender/
├─ package.json
├─ README.md
├─ server/
│  └─ index.js
└─ extension/
   ├─ manifest.json
   ├─ service-worker.js
   ├─ popup.html
   ├─ popup.js
   └─ popup.css
```

## Requirements

- Node.js
- Google Chrome
- Two Chrome profiles if you want profile `A` and profile `B` to participate separately
- An open Messenger tab in each Chrome profile you want to use

## Install

```bash
npm install
```

## Run The Server

```bash
npm start
```

Server endpoints:

- HTTP state API: `http://localhost:3000/state`
- WebSocket endpoint: `ws://localhost:3000/ws`

## Load The Extension

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `extension` folder
5. Repeat in the second Chrome profile if needed

## Configure Profiles

1. Open the extension popup in profile 1
2. Set `Profile identity` to `A`
3. Open the extension popup in profile 2
4. Set `Profile identity` to `B`

Each Chrome profile stores its own identity in `chrome.storage.local`.

## Start A Run

1. Open Messenger in the Chrome profile for `A`
2. Open Messenger in the Chrome profile for `B`
3. In the extension popup, click `Load default script` if you want the bundled sample
4. Click `Start`

Default script:

```json
[
  { "sender": "A", "text": "Hi" },
  { "sender": "B", "text": "Hello" },
  { "sender": "B", "text": "How are you?" },
  { "sender": "A", "text": "Good" }
]
```

## Notes For Live Sending

- AutoChat uses the Chrome debugger API in live mode.
- Chrome may show a debugging banner while the extension is sending messages.
- The target Messenger tab should stay open in the correct profile.
- The server keeps state in memory only. Restarting the server resets progress.

## HTTP API

- `GET /state`
- `POST /config/profile-delay`
- `POST /script/load`
- `POST /run/start`
- `POST /run/stop`
- `POST /reset`

Examples:

```bash
curl -X POST http://localhost:3000/script/load -H "Content-Type: application/json" -d "{}"
```

```bash
curl -X POST http://localhost:3000/config/profile-delay -H "Content-Type: application/json" -d "{\"profile\":\"A\",\"delayMs\":1500}"
```

```bash
curl -X POST http://localhost:3000/run/start -H "Content-Type: application/json" -d "{}"
```
