const SERVER_BASE_URL = "http://localhost:3000";
const LOG_PREFIX = "[AUTOCHAT]";

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function isSupportedAutohchatUrl(urlString) {
  return isMatchingChatUrl(urlString, "live") || isMatchingChatUrl(urlString, "test");
}

async function injectScriptsIntoTab(tab) {
  if (!tab || !tab.id || !isSupportedAutohchatUrl(tab.url)) {
    return false;
  }

  try {
    const pingResult = await pingTab(tab.id);
    if (pingResult && pingResult.ok) {
      log(`Content script already available in tab ${tab.id}.`);
    } else {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
    }
  } catch (error) {
    log(`Injecting content script into tab ${tab.id}.`);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  }

  if (isMatchingChatUrl(tab.url, "live")) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["page-bridge.js"],
      world: "MAIN"
    });
  }

  return true;
}

async function injectIntoExistingSupportedTabs() {
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter((tab) => tab.id && isSupportedAutohchatUrl(tab.url));

  for (const tab of matchingTabs) {
    try {
      await injectScriptsIntoTab(tab);
    } catch (error) {
      log(`Auto-injection failed in tab ${tab.id}: ${error.message}`);
    }
  }
}

function isMatchingChatUrl(urlString, siteMode) {
  if (typeof urlString !== "string" || !urlString) {
    return false;
  }

  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();

    if (siteMode === "test") {
      return (
        (hostname === "localhost" || hostname === "127.0.0.1") &&
        pathname.startsWith("/test-chat.html")
      );
    }

    const isMessengerHost =
      hostname === "messenger.com" || hostname.endsWith(".messenger.com");
    const isFacebookHost =
      hostname === "facebook.com" || hostname.endsWith(".facebook.com");
    const isMessagesPath = pathname.startsWith("/messages");

    // Messenger can be on messenger.com directly, or inside facebook.com/messages.
    return isMessengerHost || (isFacebookHost && isMessagesPath);
  } catch (error) {
    return false;
  }
}

async function getStoredSettings() {
  return chrome.storage.local.get({
    profileIdentity: "A",
    siteMode: "live"
  });
}

async function pingTab(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "AUTOCHAT_PING" });
}

async function ensureContentScriptInjected() {
  const settings = await getStoredSettings();
  const tabs = await chrome.tabs.query({});

  const matchingTabs = tabs.filter(
    (tab) =>
      tab.id &&
      isMatchingChatUrl(tab.url, settings.siteMode)
  );

  if (matchingTabs.length === 0) {
    const visibleUrls = tabs
      .map((tab) => tab.url)
      .filter((url) => typeof url === "string" && url.startsWith("http"))
      .slice(0, 5);

    throw new Error(
      `No open ${settings.siteMode} chat tab matched the expected URL pattern. ` +
      `Open Messenger or facebook.com/messages in this Chrome profile. ` +
      `Seen tabs: ${visibleUrls.join(" | ")}`
    );
  }

  for (const tab of matchingTabs) {
    await injectScriptsIntoTab(tab);
  }

  return { ok: true, tabCount: matchingTabs.length };
}

async function fetchServerState() {
  const response = await fetch(`${SERVER_BASE_URL}/state`);
  if (!response.ok) {
    throw new Error(`State request failed with status ${response.status}`);
  }

  const data = await response.json();
  return data.state;
}

async function postStepComplete(stepIndex, profile) {
  const response = await fetch(`${SERVER_BASE_URL}/step/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ stepIndex, profile })
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Unknown completion error");
  }

  return data.state;
}

chrome.runtime.onInstalled.addListener(() => {
  log("Extension installed.");
  injectIntoExistingSupportedTabs().catch((error) => {
    log("Initial auto-injection failed:", error.message);
  });
});

chrome.runtime.onStartup.addListener(() => {
  log("Browser startup detected.");
  injectIntoExistingSupportedTabs().catch((error) => {
    log("Startup auto-injection failed:", error.message);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab || !tab.id) {
    return;
  }

  if (!isSupportedAutohchatUrl(tab.url)) {
    return;
  }

  injectScriptsIntoTab(tab).catch((error) => {
    log(`Tab update auto-injection failed in tab ${tabId}: ${error.message}`);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "AUTOCHAT_ENSURE_INJECTION") {
    ensureContentScriptInjected()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));

    return true;
  }

  if (message && message.type === "AUTOCHAT_POST_STEP_COMPLETE") {
    postStepComplete(message.stepIndex, message.profile)
      .then((state) => sendResponse({ ok: true, state }))
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
