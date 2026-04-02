const chatLog = document.getElementById("chatLog");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

function appendMessage(text) {
  const message = document.createElement("div");
  message.className = "message outgoing";
  message.textContent = text;
  chatLog.appendChild(message);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendCurrentInput() {
  const text = messageInput.value.trim();
  if (!text) {
    return;
  }

  appendMessage(text);
  messageInput.value = "";
  messageInput.dispatchEvent(new Event("input", { bubbles: true }));
}

sendButton.addEventListener("click", sendCurrentInput);

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendCurrentInput();
  }
});

appendMessage("Test page ready. The extension can send messages here.");
