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

  function placeCaretAtEnd(element) {
    const selection = window.getSelection();
    const range = document.createRange();

    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function replaceEditorText(input, text) {
    try {
      input.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");

      const inserted = document.execCommand("insertText", false, text);
      if (inserted && input.textContent.includes(text)) {
        return true;
      }

      input.innerHTML = "";
      const paragraph = document.createElement("p");
      paragraph.setAttribute("dir", "auto");
      paragraph.textContent = text;
      input.appendChild(paragraph);
      placeCaretAtEnd(paragraph);
      input.dispatchEvent(new Event("input", { bubbles: true }));

      return input.textContent.includes(text);
    } catch (error) {
      return false;
    }
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

      const inserted = replaceEditorText(input, text);
      if (!inserted) {
        emitResult({ ok: false, error: "Could not insert text into Messenger input." });
        return;
      }

      setTimeout(() => {
        pressEnter(input);
        emitResult({ ok: true });
      }, 250);
    } catch (error) {
      emitResult({ ok: false, error: error.message || "Unknown page bridge error." });
    }
  });
})();
