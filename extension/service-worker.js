const SERVER_BASE_URL = "http://localhost:3000";
const SERVER_WS_URL = "ws://localhost:3000/ws";
const LOG_PREFIX = "[AUTOCHAT]";
const SOCKET_RECONNECT_DELAY_MS = 2000;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const LIVE_INPUT_SELECTORS = [
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'div[role="textbox"][contenteditable="true"][aria-label="Message"]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder="Aa"]',
  'div[role="textbox"][contenteditable="true"]',
  'div[aria-label="Message"][contenteditable="true"]',
  'div[contenteditable="true"]'
];

let socket = null;
let reconnectTimerId = null;
let activeDispatchId = null;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function isMessengerUrl(urlString) {
  if (typeof urlString !== "string" || !urlString) {
    return false;
  }

  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    const isMessengerHost =
      hostname === "messenger.com" || hostname.endsWith(".messenger.com");
    const isFacebookHost =
      hostname === "facebook.com" || hostname.endsWith(".facebook.com");
    const isMessagesPath = pathname.startsWith("/messages");

    return isMessengerHost || (isFacebookHost && isMessagesPath);
  } catch (error) {
    return false;
  }
}

async function getStoredSettings() {
  return chrome.storage.local.get({
    profileIdentity: "A"
  });
}

async function fetchServerState() {
  const response = await fetch(`${SERVER_BASE_URL}/state`);
  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `State request failed with status ${response.status}`);
  }

  return data.state;
}

async function findMessengerTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id && isMessengerUrl(tab.url));
}

async function ensureMessengerTabAvailable() {
  const matchingTabs = await findMessengerTabs();
  if (matchingTabs.length === 0) {
    throw new Error(
      "No open Messenger tab matched the expected URL pattern. " +
      "Open messenger.com or facebook.com/messages in this Chrome profile."
    );
  }

  return { ok: true, tabCount: matchingTabs.length };
}

async function findDispatchTab() {
  const matchingTabs = await findMessengerTabs();
  if (matchingTabs.length === 0) {
    return null;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab && activeTab.id && isMessengerUrl(activeTab.url)) {
    return activeTab;
  }

  return matchingTabs[0];
}

function scheduleReconnect(delayMs = SOCKET_RECONNECT_DELAY_MS) {
  if (reconnectTimerId !== null) {
    clearTimeout(reconnectTimerId);
  }

  reconnectTimerId = setTimeout(() => {
    reconnectTimerId = null;
    connectSocket();
  }, delayMs);
}

function sendSocketMessage(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }

  socket.send(JSON.stringify(payload));
  return true;
}

async function sendRegistration() {
  const settings = await getStoredSettings();
  const sent = sendSocketMessage({
    type: "register_worker",
    profile: settings.profileIdentity
  });

  if (!sent) {
    throw new Error("WebSocket is not connected.");
  }
}

function getDebuggerTarget(tabId) {
  return { tabId };
}

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach(getDebuggerTarget(tabId), DEBUGGER_PROTOCOL_VERSION);
  } catch (error) {
    if (!error.message || !error.message.includes("Another debugger is already attached")) {
      throw error;
    }
  }
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach(getDebuggerTarget(tabId));
  } catch (_) {
    // Ignore cleanup errors.
  }
}

async function sendDebuggerCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand(getDebuggerTarget(tabId), method, params);
}

function buildLiveInputLookupExpression() {
  return `(() => {
    const selectors = ${JSON.stringify(LIVE_INPUT_SELECTORS)};
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (!el) continue;
        el.focus();
        return {
          ok: true,
          selector,
          text: (el.textContent || "").replace(/\\u200b/g, "").trim()
        };
      } catch (_) {}
    }
    return { ok: false, error: "Messenger input not found." };
  })()`;
}

async function evaluateInTab(tabId, expression) {
  const result = await sendDebuggerCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false
  });

  return result && result.result ? result.result.value : null;
}

async function focusLiveInput(tabId) {
  const result = await evaluateInTab(tabId, buildLiveInputLookupExpression());
  if (!result || !result.ok) {
    throw new Error(result && result.error ? result.error : "Messenger input not found.");
  }

  return result;
}

async function clearFocusedInput(tabId) {
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17,
    modifiers: 2
  });

  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    text: "a",
    unmodifiedText: "a",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });

  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: 2
  });

  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Control",
    code: "ControlLeft",
    windowsVirtualKeyCode: 17,
    nativeVirtualKeyCode: 17
  });

  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });

  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8
  });
}

async function pressEnterViaDebugger(tabId) {
  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: "\r",
    unmodifiedText: "\r"
  });

  await sendDebuggerCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
}

async function verifyLiveInputText(tabId) {
  const result = await evaluateInTab(tabId, buildLiveInputLookupExpression());
  return result && result.ok ? result.text : null;
}

async function sendLiveStepViaDebugger(tab, message) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  await attachDebugger(tab.id);

  try {
    await focusLiveInput(tab.id);

    if (message.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, message.delayMs));
      await focusLiveInput(tab.id);
    }

    await clearFocusedInput(tab.id);
    await sendDebuggerCommand(tab.id, "Input.insertText", { text: message.text });

    const insertedText = await verifyLiveInputText(tab.id);
    if (insertedText !== message.text.trim()) {
      throw new Error(`Live input mismatch after debugger insert. Saw "${insertedText || ""}".`);
    }

    await pressEnterViaDebugger(tab.id);
    return { ok: true };
  } finally {
    await detachDebugger(tab.id);
  }
}

async function handleDispatchStep(message) {
  if (activeDispatchId !== null) {
    sendSocketMessage({
      type: "step_result",
      dispatchId: message.dispatchId,
      ok: false,
      error: `Worker already handling dispatch ${activeDispatchId}.`
    });
    return;
  }

  activeDispatchId = message.dispatchId;

  try {
    const settings = await getStoredSettings();
    if (settings.profileIdentity !== message.sender) {
      throw new Error(
        `Profile mismatch. Worker is ${settings.profileIdentity}, dispatch is for ${message.sender}.`
      );
    }

    const targetTab = await findDispatchTab();
    if (!targetTab || !targetTab.id) {
      throw new Error(`No Messenger tab available for profile ${settings.profileIdentity}.`);
    }

    const result = await sendLiveStepViaDebugger(targetTab, {
      text: message.text,
      delayMs: message.delayMs || 0
    });

    sendSocketMessage({
      type: "step_result",
      dispatchId: message.dispatchId,
      ok: Boolean(result && result.ok),
      error: result && result.ok ? null : result && result.error ? result.error : "Send failed.",
      tabId: targetTab.id
    });
  } catch (error) {
    sendSocketMessage({
      type: "step_result",
      dispatchId: message.dispatchId,
      ok: false,
      error: error.message || "Unhandled dispatch error."
    });
  } finally {
    activeDispatchId = null;
  }
}

async function handleSocketMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch (error) {
    log("Received invalid WebSocket JSON.");
    return;
  }

  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "welcome" || message.type === "registered" || message.type === "state_update") {
    return;
  }

  if (message.type === "heartbeat") {
    sendSocketMessage({
      type: "heartbeat_ack",
      now: Date.now()
    });
    return;
  }

  if (message.type === "dispatch_step") {
    await handleDispatchStep(message);
    return;
  }

  if (message.type === "error") {
    log(`Server error: ${message.error}`);
  }
}

function connectSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  socket = new WebSocket(SERVER_WS_URL);

  socket.addEventListener("open", () => {
    log("WebSocket connected.");
    sendRegistration().catch((error) => {
      log(`Registration failed: ${error.message}`);
    });
  });

  socket.addEventListener("message", (event) => {
    handleSocketMessage(event.data).catch((error) => {
      log(`WebSocket message handling failed: ${error.message}`);
    });
  });

  socket.addEventListener("close", () => {
    socket = null;
    log("WebSocket disconnected. Reconnecting...");
    scheduleReconnect();
  });

  socket.addEventListener("error", (event) => {
    const message = event && event.message ? event.message : "Unknown WebSocket error.";
    log(message);
  });
}

chrome.runtime.onInstalled.addListener(() => {
  log("Extension installed.");
  connectSocket();
});

chrome.runtime.onStartup.addListener(() => {
  log("Browser startup detected.");
  connectSocket();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.profileIdentity) {
    return;
  }

  connectSocket();
  sendRegistration().catch((error) => {
    log(`Registration refresh failed: ${error.message}`);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "AUTOCHAT_ENSURE_READY") {
    ensureMessengerTabAvailable()
      .then((result) => {
        connectSocket();
        return sendRegistration().then(() => result);
      })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message && message.type === "AUTOCHAT_RUN_DISPATCH_NOW") {
    connectSocket();
    sendRegistration()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (!message || message.type !== "AUTOCHAT_GET_SERVER_STATE") {
    return false;
  }

  fetchServerState()
    .then((state) => sendResponse({ ok: true, state }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

connectSocket();
