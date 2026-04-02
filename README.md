# AutoChat MVP

This project is a small local MVP for scripted two-profile chat automation.

It has two parts:

1. A local Node.js server on `localhost:3000`
2. A Chrome Manifest V3 extension installed in two different Chrome profiles

The same extension code runs in both profiles. Each profile stores its own identity, either `A` or `B`.

## Folder Structure

```text
auto-message-sender/
├─ package.json
├─ README.md
├─ server/
│  └─ index.js
├─ extension/
│  ├─ manifest.json
│  ├─ service-worker.js
│  ├─ content.js
│  ├─ popup.html
│  ├─ popup.js
│  └─ popup.css
└─ public/
   ├─ test-chat.html
   ├─ test-chat.css
   └─ test-chat.js
```

## How To Run The Node Server

1. Open a terminal in this project folder.
2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

4. Open the local test page:

```text
http://localhost:3000/test-chat.html
```

## How To Load The Extension Unpacked In Chrome

1. Open Chrome.
2. Go to `chrome://extensions`
3. Turn on `Developer mode`
4. Click `Load unpacked`
5. Select the `extension` folder from this project

## How To Install In Both Chrome Profiles

1. Open Chrome Profile 1
2. Load the unpacked extension in Profile 1
3. Open Chrome Profile 2
4. Load the same unpacked extension in Profile 2

Each Chrome profile has its own `chrome.storage.local`, so each one can store a different identity.

## How To Set One Profile To A And The Other To B

1. Open the extension popup in Profile 1
2. Set `Profile identity` to `A`
3. Open the extension popup in Profile 2
4. Set `Profile identity` to `B`

The saved identity is local to that browser profile.

## How To Test With The Local Fake Chat Page First

1. Start the Node server
2. Open `http://localhost:3000/test-chat.html` in both Chrome profiles
3. Open the extension popup in both profiles
4. In both profiles, set `Mode` to `Test page`
5. In one popup, click `Load sample script`
6. Click `Start`
7. Watch the two profiles poll the server and take turns sending

Default sample script:

```json
[
  { "sender": "A", "text": "Hi" },
  { "sender": "B", "text": "Hello" },
  { "sender": "B", "text": "How are you?" },
  { "sender": "A", "text": "Good" }
]
```

## Request Flow

1. The popup calls the local server to load a script or start/stop/reset the run.
2. The service worker polls `GET /state` every ~1.8 seconds.
3. If the current step belongs to the local profile identity, the service worker sends a message to the content script in the matching tab.
4. The content script waits for the configured delay, fills the input, and clicks send.
5. If the send succeeds, the service worker calls `POST /step/complete`.
6. The server advances `currentStep`.
7. On the next poll, the other profile sees whether the next step belongs to it.

## Node Server Routes

- `GET /state`
- `POST /config/profile-delay`
- `POST /script/load`
- `POST /run/start`
- `POST /run/stop`
- `POST /step/complete`
- `POST /reset`

## How To Adapt Selectors For The Real Chat Page

All site-specific DOM selectors are intentionally kept in one place:

- `extension/content.js`

Look for this object:

```js
const SITE_SELECTORS = {
  test: {
    input: ['[data-autochat="message-input"]'],
    sendButton: ['[data-autochat="send-button"]']
  },
  live: {
    input: [],
    sendButton: []
  }
};
```

For the real chat site:

1. Open the real chat page
2. Right-click the message input and choose `Inspect`
3. Find a stable selector for the input
4. Find a stable selector for the send button
5. Replace the empty `live.input` and `live.sendButton` arrays

Example pattern:

```js
live: {
  input: ['textarea[data-role="chat-input"]'],
  sendButton: ['button[data-role="send-message"]']
}
```

Also update the manifest and service worker URL pattern:

1. In `extension/manifest.json`, replace `https://example.com/*`
2. In `extension/service-worker.js`, replace the `live` URL prefix returned by `getUrlPrefixForMode()`

Important:

- Do not scatter selectors across the file
- Do not edit the test selectors unless you are changing the fake page
- If the site uses a rich editor instead of a normal textarea, you may need to update `setInputText()`

## Known Race Conditions And How This MVP Reduces Them

1. The service worker uses `currentlySending` so it does not launch two sends at once.
2. The service worker tracks `lastAttemptedStep` so the same poll cycle does not send the same step repeatedly.
3. The content script tracks its own `currentlySending`.
4. The content script tracks `lastCompletedStepIndex` and `lastAttemptedStepIndex`.
5. The server only advances when `stepIndex === currentStep`.
6. The server also checks that the profile calling `/step/complete` matches the sender for the current step.

This means duplicate sends are reduced, but not perfectly eliminated. For example, a real site could accept the message visually while the extension fails before reporting completion. That would leave the server behind the UI state. This MVP accepts that limitation to stay simple.

## Known Limitations

- State is in memory only. Restarting the server clears progress.
- No database is used.
- No websocket is used.
- The service worker uses polling, so timing is approximate.
- The fake test page proves the full loop, but real chat sites may need selector and event adjustments.
- Some chat sites use custom editors that need more than setting `.value`.
- The real site URL pattern must be updated before live use.
- This project is for your own testing and learning only.

## Notes About The Server State

```json
{
  "running": false,
  "currentStep": 0,
  "lastCompletedStep": -1,
  "lastProcessedEventId": 0,
  "script": [
    { "sender": "A", "text": "Hi" },
    { "sender": "B", "text": "Hello" }
  ],
  "delayMs": {
    "A": 2000,
    "B": 3000
  }
}
```

## Simple API Examples

Load the default sample script:

```bash
curl -X POST http://localhost:3000/script/load -H "Content-Type: application/json" -d "{}"
```

Update a delay:

```bash
curl -X POST http://localhost:3000/config/profile-delay -H "Content-Type: application/json" -d "{\"profile\":\"A\",\"delayMs\":1500}"
```

Start the run:

```bash
curl -X POST http://localhost:3000/run/start -H "Content-Type: application/json" -d "{}"
```
