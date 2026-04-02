if (window.__AUTOCHAT_CONTENT_READY__) {
  console.log("[AUTOCHAT] Content script already initialized in this tab. Skipping duplicate load.");
} else {
window.__AUTOCHAT_CONTENT_READY__ = true;

const LOG_PREFIX = "[AUTOCHAT]";
const POLL_INTERVAL_MS = 1500;
const PAGE_BRIDGE_EVENT = "AUTOCHAT_PAGE_BRIDGE_SEND";
const PAGE_BRIDGE_RESULT_EVENT = "AUTOCHAT_PAGE_BRIDGE_RESULT";

let currentlySending = false;
let lastCompletedStepIndex = -1;
let lastAttemptedStepIndex = -1;
let pollIntervalId = null;

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

// ---------------------------------------------------------------------------
// Page bridge – runs in the PAGE context (not the extension sandbox) so it
// can access the React/Lexical internals that Messenger uses.
// ---------------------------------------------------------------------------
function injectPageBridge() {
  if (document.documentElement.dataset.autochatBridgeReady === "true") {
    return;
  }

  const script = document.createElement("script");
  script.id = "autochat-page-bridge";
  script.textContent = `
    (() => {
      const SEND_EVENT = "${PAGE_BRIDGE_EVENT}";
      const RESULT_EVENT = "${PAGE_BRIDGE_RESULT_EVENT}";
      window.AUTOCHAT_PAGE_BRIDGE_READY = true;
      document.documentElement.dataset.autochatBridgeReady = "true";

      function emitResult(detail) {
        window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail }));
      }

      // -------------------------------------------------------------------
      // Selector helpers
      // -------------------------------------------------------------------
      function getMessengerInput() {
        // Messenger / Facebook use Lexical – the actual editable is always
        // the element with data-lexical-editor="true".
        return (
          document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') ||
          document.querySelector('div[role="textbox"][contenteditable="true"]') ||
          document.querySelector('div[aria-label="Message"][contenteditable="true"]') ||
          document.querySelector('div[aria-placeholder="Aa"][contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"]')
        );
      }

      function findMessengerSendButton() {
        // Try all known Messenger send-button patterns, newest first.
        return (
          document.querySelector('div[aria-label="Press Enter to send"]') ||
          document.querySelector('button[aria-label="Press Enter to send"]') ||
          document.querySelector('div[aria-label="Send"]') ||
          document.querySelector('button[aria-label="Send"]') ||
          document.querySelector('div[role="button"][aria-label*="Send"]') ||
          document.querySelector('[data-testid="mwThreadbot-send-button"]') ||
          document.querySelector('[data-testid="send-button"]')
        );
      }

      // -------------------------------------------------------------------
      // Text insertion – works with Lexical / React controlled editors.
      // Strategy 1: clipboard paste (most reliable for Lexical)
      // Strategy 2: input event chain
      // Strategy 3: execCommand fallback (legacy)
      // -------------------------------------------------------------------
      function insertViaClipboard(el, text) {
        el.focus();

        // Select all existing content so we replace it cleanly.
        document.execCommand("selectAll");

        const dt = new DataTransfer();
        dt.setData("text/plain", text);

        el.dispatchEvent(new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        }));

        return el.textContent.trim() !== "" || el.innerText.trim() !== "";
      }

      function insertViaInputEvent(el, text) {
        el.focus();
        document.execCommand("selectAll");
        document.execCommand("delete");

        // Insert character-by-character so Lexical's onChange fires.
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLElement.prototype, "textContent"
        );

        el.dispatchEvent(new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text
        }));

        // Directly set innerHTML the way Lexical expects: a paragraph node.
        el.innerHTML = '<p dir="auto"><br></p>';
        const p = el.querySelector("p");
        if (p) {
          p.textContent = text;
        } else {
          el.textContent = text;
        }

        el.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: text
        }));

        // Place caret at end.
        const selection = window.getSelection();
        const range = document.createRange();
        const target = el.querySelector("p") || el;
        range.selectNodeContents(target);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        return true;
      }

      function insertViaExecCommand(el, text) {
        el.focus();
        document.execCommand("selectAll");
        return document.execCommand("insertText", false, text);
      }

      function pressEnter(target) {
        const init = {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true
        };
        target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keypress", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
      }

      // -------------------------------------------------------------------
      // Main listener
      // -------------------------------------------------------------------
      window.addEventListener(SEND_EVENT, (event) => {
        try {
          const text = event.detail && event.detail.text;
          if (!text) {
            emitResult({ ok: false, error: "No text provided to page bridge." });
            return;
          }

          const input = getMessengerInput();
          if (!input) {
            emitResult({ ok: false, error: "Messenger input not found in page context." });
            return;
          }

          // Try clipboard paste first (works best with Lexical).
          let inserted = insertViaClipboard(input, text);
          if (!inserted) {
            inserted = insertViaInputEvent(input, text);
          }
          if (!inserted) {
            insertViaExecCommand(input, text);
          }

          // Give Lexical a tick to process the paste before we send.
          setTimeout(() => {
            const sendButton = findMessengerSendButton();
            if (sendButton) {
              sendButton.click();
            } else {
              pressEnter(input);
            }
            emitResult({ ok: true });
          }, 300);

        } catch (error) {
          emitResult({ ok: false, error: error.message || "Unknown page bridge error" });
        }
      });
    })();
  `;

  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
  log("Page bridge injected.");
}

function sendViaPageBridge(text) {
  return new Promise((resolve) => {
    let settled = false;

    function handleResult(event) {
      if (settled) return;
      settled = true;
      window.removeEventListener(PAGE_BRIDGE_RESULT_EVENT, handleResult);
      resolve(event.detail || { ok: false, error: "No page bridge result." });
    }

    window.addEventListener(PAGE_BRIDGE_RESULT_EVENT, handleResult);
    window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: { text } }));

    // Timeout extended to 4 s to account for the 300 ms send delay + any lag.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener(PAGE_BRIDGE_RESULT_EVENT, handleResult);
      resolve({ ok: false, error: "Timed out waiting for page bridge send result." });
    }, 4000);
  });
}

// ---------------------------------------------------------------------------
// Site / mode detection
// ---------------------------------------------------------------------------
function getSiteModeFromUrl() {
  const origin = window.location.origin;
  if (
    origin === "http://localhost:3000" ||
    origin === "http://127.0.0.1:3000"
  ) {
    return "test";
  }
  return "live";
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------
const SITE_SELECTORS = {
  test: {
    input: ['[data-autochat="message-input"]'],
    sendButton: ['[data-autochat="send-button"]']
  },
  live: {
    // Ordered from most specific / stable to most generic.
    // Update only this section if Messenger changes its DOM.
    input: [
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[role="textbox"][contenteditable="true"][aria-label="Message"]',
      'div[role="textbox"][contenteditable="true"][aria-placeholder="Aa"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[aria-label="Message"][contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    sendButton: [
      'div[aria-label="Press Enter to send"]',
      'button[aria-label="Press Enter to send"]',
      'div[aria-label="Send"]',
      'button[aria-label="Send"]',
      'div[role="button"][aria-label*="Send"]',
      '[data-testid="mwThreadbot-send-button"]',
      '[data-testid="send-button"]'
    ]
  }
};

function getSelectors() {
  return SITE_SELECTORS[getSiteModeFromUrl()];
}

function findFirstMatchingElement(selectorList) {
  for (const selector of selectorList) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch (_) {
      // ignore invalid selectors
    }
  }
  return null;
}

function findMessageInput() {
  const selectors = getSelectors();
  const input = findFirstMatchingElement(selectors.input);
  if (!input) {
    log(
      `Could not find the chat input box. Mode: "${getSiteModeFromUrl()}". ` +
      "Update the selectors in content.js if needed."
    );
  }
  return input;
}

function findSendButton() {
  return findFirstMatchingElement(getSelectors().sendButton);
}

// ---------------------------------------------------------------------------
// DOM helpers (used in test mode)
// ---------------------------------------------------------------------------
function getEditableTarget(inputElement) {
  if (inputElement.isContentEditable) return inputElement;
  return inputElement.closest('[contenteditable="true"]') || inputElement;
}

function placeCaretAtEnd(element) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function setInputText(inputElement, text) {
  const editableTarget = getEditableTarget(inputElement);

  if (editableTarget.isContentEditable) {
    editableTarget.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editableTarget);
    selection.removeAllRanges();
    selection.addRange(range);

    const inserted = document.execCommand("insertText", false, text);

    if (!inserted || !editableTarget.textContent.includes(text)) {
      editableTarget.innerHTML = "";
      const p = document.createElement("p");
      p.setAttribute("dir", "auto");
      p.appendChild(document.createTextNode(text));
      editableTarget.appendChild(p);
      placeCaretAtEnd(editableTarget);
      editableTarget.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" })
      );
    }
    return;
  }

  const isTextArea = inputElement.tagName === "TEXTAREA";
  const nativeSetter = isTextArea
    ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
    : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  if (nativeSetter) {
    nativeSetter.call(inputElement, text);
  } else {
    inputElement.value = text;
  }

  inputElement.dispatchEvent(new Event("input", { bubbles: true }));
  inputElement.dispatchEvent(new Event("change", { bubbles: true }));
}

function triggerEnterSend(inputElement) {
  const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  inputElement.dispatchEvent(new KeyboardEvent("keydown", init));
  inputElement.dispatchEvent(new KeyboardEvent("keypress", init));
  inputElement.dispatchEvent(new KeyboardEvent("keyup", init));
}

function triggerSend(inputElement) {
  const sendButton = findSendButton();
  if (sendButton) {
    sendButton.click();
    return;
  }
  triggerEnterSend(getEditableTarget(inputElement));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function getStoredSettings() {
  return chrome.storage.local.get({
    profileIdentity: "A",
    siteMode: "live"   // default changed to "live" so Messenger works out of the box
  });
}

// ---------------------------------------------------------------------------
// Server communication
// ---------------------------------------------------------------------------
async function fetchServerState() {
  const result = await chrome.runtime.sendMessage({
    type: "AUTOCHAT_GET_SERVER_STATE"
  });

  if (!result || !result.ok) {
    throw new Error(result && result.error ? result.error : "Could not get server state from extension background.");
  }

  return result.state;
}

async function postStepComplete(stepIndex, profile) {
  const result = await chrome.runtime.sendMessage({
    type: "AUTOCHAT_POST_STEP_COMPLETE",
    stepIndex,
    profile
  });

  if (!result || !result.ok) {
    throw new Error(result && result.error ? result.error : "Could not post step completion through extension background.");
  }

  return result.state;
}

// ---------------------------------------------------------------------------
// Send orchestration
// ---------------------------------------------------------------------------
async function sendMessageToCurrentChat({ text, stepIndex, delayMs }) {
  if (currentlySending) {
    return { ok: false, error: "Content script is already sending a message." };
  }

  if (stepIndex === lastCompletedStepIndex) {
    return { ok: false, error: `Step ${stepIndex} was already completed in this tab.` };
  }

  if (stepIndex === lastAttemptedStepIndex) {
    return { ok: false, error: `Step ${stepIndex} already attempted – waiting for retry.` };
  }

  const mode = getSiteModeFromUrl();

  // In live mode the page bridge handles finding the input itself.
  // In test mode we need the input element here.
  const input = mode === "live" ? true : findMessageInput();
  if (!input) {
    return { ok: false, error: "Message input not found. See content.js selectors." };
  }

  currentlySending = true;
  lastAttemptedStepIndex = stepIndex;

  try {
    if (delayMs > 0) {
      await wait(delayMs);
    }

    if (mode === "live") {
      const bridgeResult = await sendViaPageBridge(text);
      if (!bridgeResult.ok) {
        lastAttemptedStepIndex = -1;
        return bridgeResult;
      }
    } else {
      // ---- test mode ----
      const inputEl = findMessageInput(); // re-query after delay
      if (!inputEl) {
        lastAttemptedStepIndex = -1;
        return { ok: false, error: "Message input disappeared after delay." };
      }

      inputEl.focus();
      setInputText(inputEl, text);
      await wait(400);

      const refreshedSendButton = findSendButton();
      if (refreshedSendButton) {
        refreshedSendButton.click();
      } else {
        triggerSend(inputEl);
      }

      await wait(600);

      const sentTextStillPresent = getEditableTarget(inputEl).textContent.includes(text);
      if (sentTextStillPresent) {
        lastAttemptedStepIndex = -1;
        return { ok: false, error: "Text was inserted but does not appear to have been sent." };
      }
    }

    lastCompletedStepIndex = stepIndex;
    return { ok: true };
  } catch (error) {
    lastAttemptedStepIndex = -1;
    return { ok: false, error: error.message || "Unknown send error" };
  } finally {
    currentlySending = false;
  }
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------
async function pollServerAndMaybeSendFromPage() {
  if (currentlySending) return;

  if (document.visibilityState !== "visible") {
    return;
  }

  try {
    const settings = await getStoredSettings();
    const pageMode = getSiteModeFromUrl();

    if (settings.siteMode !== pageMode) return;

    const state = await fetchServerState();

    if (!state.running || !state.nextStep) {
      lastAttemptedStepIndex = -1;
      return;
    }

    const nextStep = state.nextStep;

    if (nextStep.sender !== settings.profileIdentity) return;

    if (
      nextStep.index === lastCompletedStepIndex ||
      nextStep.index === lastAttemptedStepIndex
    ) {
      return;
    }

    const sendResult = await sendMessageToCurrentChat({
      text: nextStep.text,
      stepIndex: nextStep.index,
      delayMs: state.delayMs[nextStep.sender] || 0
    });

    if (!sendResult.ok) {
      throw new Error(sendResult.error || "Send failed");
    }

    await postStepComplete(nextStep.index, settings.profileIdentity);
    log(`Step ${nextStep.index} completed by profile ${settings.profileIdentity}.`);
  } catch (error) {
    if (!currentlySending) {
      lastAttemptedStepIndex = -1;
    }
    log("Page polling/send failed:", error.message);
  }
}

function startPagePollingLoop() {
  if (pollIntervalId !== null) return;

  pollIntervalId = setInterval(() => {
    pollServerAndMaybeSendFromPage();
  }, POLL_INTERVAL_MS);

  log(`Page polling loop started at ${POLL_INTERVAL_MS}ms.`);
}

// ---------------------------------------------------------------------------
// Message listener (triggered by service worker → content script)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "AUTOCHAT_PING") {
    sendResponse({ ok: true, mode: getSiteModeFromUrl() });
    return false;
  }

  if (!message || message.type !== "AUTOCHAT_SEND_STEP") {
    return false;
  }

  log(`Received step ${message.stepIndex} for sender ${message.sender}.`);

  sendMessageToCurrentChat({
    text: message.text,
    stepIndex: message.stepIndex,
    delayMs: message.delayMs || 0
  })
    .then((result) => {
      if (!result.ok) {
        log(`Step ${message.stepIndex} failed: ${result.error}`);
      } else {
        log(`Step ${message.stepIndex} sent successfully.`);
      }
      sendResponse(result);
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || "Unhandled content script error" });
    });

  return true;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
log(`Content script loaded in ${getSiteModeFromUrl()} mode.`);
startPagePollingLoop();
}
