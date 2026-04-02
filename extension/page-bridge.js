(function () {
  if (window.AUTOCHAT_PAGE_BRIDGE_READY) {
    return;
  }

  const SEND_EVENT = "AUTOCHAT_PAGE_BRIDGE_SEND";
  const RESULT_EVENT = "AUTOCHAT_PAGE_BRIDGE_RESULT";

  window.AUTOCHAT_PAGE_BRIDGE_READY = true;
  document.documentElement.dataset.autochatBridgeReady = "true";

  function emitResult(detail) {
    window.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail }));
  }

  function getMessengerInput() {
    return (
      document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') ||
      document.querySelector('div[role="textbox"][contenteditable="true"][aria-label="Message"]') ||
      document.querySelector('div[role="textbox"][contenteditable="true"][aria-placeholder="Aa"]') ||
      document.querySelector('div[role="textbox"][contenteditable="true"]') ||
      document.querySelector('div[aria-label="Message"][contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  function findMessengerSendButton() {
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

  function insertViaClipboard(el, text) {
    try {
      el.focus();
      document.execCommand("selectAll");

      const dt = new DataTransfer();
      dt.setData("text/plain", text);

      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        })
      );

      return el.textContent.trim() !== "" || el.innerText.trim() !== "";
    } catch (error) {
      return false;
    }
  }

  function insertViaInputEvent(el, text) {
    try {
      el.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");

      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: text
        })
      );

      el.innerHTML = '<p dir="auto"><br></p>';
      const paragraph = el.querySelector("p");
      if (paragraph) {
        paragraph.textContent = text;
      } else {
        el.textContent = text;
      }

      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          inputType: "insertText",
          data: text
        })
      );

      const selection = window.getSelection();
      const range = document.createRange();
      const target = el.querySelector("p") || el;
      range.selectNodeContents(target);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      return true;
    } catch (error) {
      return false;
    }
  }

  function insertViaExecCommand(el, text) {
    try {
      el.focus();
      document.execCommand("selectAll");
      return document.execCommand("insertText", false, text);
    } catch (error) {
      return false;
    }
  }

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

      let inserted = insertViaClipboard(input, text);
      if (!inserted) {
        inserted = insertViaInputEvent(input, text);
      }
      if (!inserted) {
        inserted = insertViaExecCommand(input, text);
      }

      if (!inserted) {
        emitResult({ ok: false, error: "Could not insert text into Messenger input." });
        return;
      }

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
