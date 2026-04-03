if (window.__AUTOCHAT_CONTENT_READY__) {
  console.log("[AUTOCHAT] Content script already initialized in this tab. Skipping duplicate load.");
} else {
  window.__AUTOCHAT_CONTENT_READY__ = true;

  const LOG_PREFIX = "[AUTOCHAT]";
  const PAGE_BRIDGE_EVENT = "AUTOCHAT_PAGE_BRIDGE_SEND";
  const PAGE_BRIDGE_RESULT_EVENT = "AUTOCHAT_PAGE_BRIDGE_RESULT";

  let currentlySending = false;
  let lastCompletedStepIndex = -1;
  let lastAttemptedStepIndex = -1;

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

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

  const SITE_SELECTORS = {
    test: {
      input: ['[data-autochat="message-input"]'],
      sendButton: ['[data-autochat="send-button"]']
    },
    live: {
      input: [
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[role="textbox"][contenteditable="true"][aria-label="Message"]',
        'div[role="textbox"][contenteditable="true"][aria-placeholder="Aa"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[aria-label="Message"][contenteditable="true"]',
        'div[contenteditable="true"]'
      ],
      sendButton: []
    }
  };

  function getSelectors() {
    return SITE_SELECTORS[getSiteModeFromUrl()];
  }

  function findFirstMatchingElement(selectorList) {
    for (const selector of selectorList) {
      try {
        const element = document.querySelector(selector);
        if (element) {
          return element;
        }
      } catch (_) {
        // Ignore invalid selectors and keep trying.
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

  function getEditableTarget(inputElement) {
    if (inputElement.isContentEditable) {
      return inputElement;
    }

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
        const paragraph = document.createElement("p");
        paragraph.setAttribute("dir", "auto");
        paragraph.appendChild(document.createTextNode(text));
        editableTarget.appendChild(paragraph);
        placeCaretAtEnd(editableTarget);
        editableTarget.dispatchEvent(new Event("input", { bubbles: true }));
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
    const init = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };

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

  function sendViaPageBridge(text) {
    return new Promise((resolve) => {
      let settled = false;

      function handleResult(event) {
        if (settled) {
          return;
        }

        settled = true;
        window.removeEventListener(PAGE_BRIDGE_RESULT_EVENT, handleResult);
        resolve(event.detail || { ok: false, error: "No page bridge result." });
      }

      window.addEventListener(PAGE_BRIDGE_RESULT_EVENT, handleResult);
      window.dispatchEvent(new CustomEvent(PAGE_BRIDGE_EVENT, { detail: { text } }));

      setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        window.removeEventListener(PAGE_BRIDGE_RESULT_EVENT, handleResult);
        resolve({ ok: false, error: "Timed out waiting for page bridge send result." });
      }, 4000);
    });
  }

  async function sendMessageToCurrentChat({ text, stepIndex, delayMs }) {
    if (currentlySending) {
      return { ok: false, error: "Content script is already sending a message." };
    }

    if (stepIndex === lastCompletedStepIndex) {
      return { ok: false, error: `Step ${stepIndex} was already completed in this tab.` };
    }

    if (stepIndex === lastAttemptedStepIndex) {
      return { ok: false, error: `Step ${stepIndex} was already attempted in this tab.` };
    }

    const mode = getSiteModeFromUrl();
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
        const inputElement = findMessageInput();
        if (!inputElement) {
          lastAttemptedStepIndex = -1;
          return { ok: false, error: "Message input disappeared before sending." };
        }

        inputElement.focus();
        setInputText(inputElement, text);
        await wait(200);
        triggerSend(inputElement);
        await wait(250);

        const sentTextStillPresent = getEditableTarget(inputElement).textContent.includes(text);
        if (sentTextStillPresent) {
          lastAttemptedStepIndex = -1;
          return { ok: false, error: "Text was inserted but does not appear to have been sent." };
        }
      }

      lastCompletedStepIndex = stepIndex;
      return { ok: true };
    } catch (error) {
      lastAttemptedStepIndex = -1;
      return { ok: false, error: error.message || "Unknown send error." };
    } finally {
      currentlySending = false;
    }
  }

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
        sendResponse({ ok: false, error: error.message || "Unhandled content script error." });
      });

    return true;
  });

  log(`Content script loaded in ${getSiteModeFromUrl()} mode.`);
}
