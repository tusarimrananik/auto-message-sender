const SERVER_BASE_URL = "http://localhost:3000";
const LOG_PREFIX = "[AUTOCHAT]";

const STORAGE_DEFAULTS = {
  profileIdentity: "A",
  customDisplayName: "",
  customProfilePhotoUrl: ""
};

const profileSelect = document.getElementById("profileIdentity");
const displayNameInput = document.getElementById("displayNameInput");
const photoUrlInput = document.getElementById("photoUrlInput");
const photoFileInput = document.getElementById("photoFileInput");
const saveAppearanceButton = document.getElementById("saveAppearanceButton");
const clearAppearanceButton = document.getElementById("clearAppearanceButton");
const appearanceHint = document.getElementById("appearanceHint");
const loadSampleButton = document.getElementById("loadSampleButton");
const loadPastedButton = document.getElementById("loadPastedButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const resetButton = document.getElementById("resetButton");
const scriptEditor = document.getElementById("scriptEditor");
const scriptHint = document.getElementById("scriptHint");

const serverStatus = document.getElementById("serverStatus");
const runningStatus = document.getElementById("runningStatus");
const currentStepStatus = document.getElementById("currentStepStatus");
const nextSenderStatus = document.getElementById("nextSenderStatus");
const nextTextStatus = document.getElementById("nextTextStatus");
const workerAStatus = document.getElementById("workerAStatus");
const workerBStatus = document.getElementById("workerBStatus");
const messageText = document.getElementById("messageText");

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function setMessage(text, isError = false) {
  messageText.textContent = text;
  messageText.style.color = isError ? "#b91c1c" : "#2563eb";
}

function setScriptHint(text, type = "") {
  scriptHint.textContent = text;
  scriptHint.className = "hint" + (type ? " " + type : "");
}

function setAppearanceHint(text, type = "") {
  appearanceHint.textContent = text;
  appearanceHint.className = "hint" + (type ? " " + type : "");
}

function updateAppearanceInputs(settings) {
  displayNameInput.value = settings.customDisplayName || "";

  if (
    settings.customProfilePhotoUrl &&
    settings.customProfilePhotoUrl.startsWith("data:")
  ) {
    photoUrlInput.value = "";
    setAppearanceHint("An uploaded image is saved for this profile.", "success");
    return;
  }

  photoUrlInput.value = settings.customProfilePhotoUrl || "";

  if (settings.customDisplayName || settings.customProfilePhotoUrl) {
    setAppearanceHint(
      "Saved overrides update any open Messenger tabs in this Chrome profile.",
      "success"
    );
  } else {
    setAppearanceHint(
      "These changes only affect what this Chrome profile sees in Messenger."
    );
  }
}

/**
 * Parse pasted JSON into a script array.
 * Expects a JSON array of { sender, text } objects.
 */
function parseScriptJson(raw) {
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Must be a JSON array.");
  }

  for (let i = 0; i < parsed.length; i += 1) {
    const step = parsed[i];
    if (!step || typeof step !== "object") {
      throw new Error(`Item at index ${i} is not an object.`);
    }
    if (step.sender !== "A" && step.sender !== "B") {
      throw new Error(`Item at index ${i}: sender must be "A" or "B".`);
    }
    if (typeof step.text !== "string" || !step.text.trim()) {
      throw new Error(`Item at index ${i}: text must be a non-empty string.`);
    }
  }

  return parsed;
}

/**
 * Convert a script array to pretty-printed JSON for the textarea.
 */
function scriptToText(script) {
  return JSON.stringify(script, null, 2);
}

async function getStoredSettings() {
  return chrome.storage.local.get(STORAGE_DEFAULTS);
}

async function saveStoredSettings(partialSettings = {}) {
  await chrome.storage.local.set({
    ...partialSettings,
    profileIdentity: profileSelect.value
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => {
      reject(new Error("Could not read the selected image file."));
    });

    reader.readAsDataURL(file);
  });
}

async function callServer(path, options = {}) {
  const response = await fetch(`${SERVER_BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(data.error || "Server request failed");
  }

  return data;
}

async function ensureMessengerReady() {
  return chrome.runtime.sendMessage({ type: "AUTOCHAT_ENSURE_READY" });
}

async function triggerDispatchNow() {
  return chrome.runtime.sendMessage({ type: "AUTOCHAT_RUN_DISPATCH_NOW" });
}

function renderState(state) {
  serverStatus.textContent = "Connected";
  runningStatus.textContent = state.running ? "Yes" : "No";
  currentStepStatus.textContent = `${state.currentStep} / ${state.totalSteps}`;
  nextSenderStatus.textContent = state.nextStep ? state.nextStep.sender : "None";
  nextTextStatus.textContent = state.nextStep ? state.nextStep.text : "Finished";
  workerAStatus.textContent =
    state.workers && state.workers.A && state.workers.A.connected
      ? "Online"
      : "Offline";
  workerBStatus.textContent =
    state.workers && state.workers.B && state.workers.B.connected
      ? "Online"
      : "Offline";

  if (!scriptEditor.value.trim() && state.script && state.script.length > 0) {
    scriptEditor.value = scriptToText(state.script);
    setScriptHint(`${state.script.length} messages loaded`, "success");
  }
}

async function refreshState() {
  try {
    const data = await callServer("/state");
    renderState(data.state);
  } catch (error) {
    serverStatus.textContent = "Offline";
    runningStatus.textContent = "-";
    currentStepStatus.textContent = "-";
    nextSenderStatus.textContent = "-";
    nextTextStatus.textContent = "-";
    workerAStatus.textContent = "-";
    workerBStatus.textContent = "-";
    setMessage(error.message, true);
  }
}

async function initializePopup() {
  const settings = await getStoredSettings();
  profileSelect.value = settings.profileIdentity;
  updateAppearanceInputs(settings);

  await refreshState();
  setInterval(refreshState, 2000);
}

profileSelect.addEventListener("change", async () => {
  await saveStoredSettings();
  await triggerDispatchNow();
  setMessage(`Saved profile identity: ${profileSelect.value}`);
});

photoFileInput.addEventListener("change", () => {
  if (!photoFileInput.files || photoFileInput.files.length === 0) {
    return;
  }

  setAppearanceHint(
    `Selected image: ${photoFileInput.files[0].name}. Click "Save Appearance" to apply it.`
  );
});

saveAppearanceButton.addEventListener("click", async () => {
  try {
    const customDisplayName = displayNameInput.value.trim();
    let customProfilePhotoUrl = photoUrlInput.value.trim();

    if (photoFileInput.files && photoFileInput.files.length > 0) {
      customProfilePhotoUrl = await readFileAsDataUrl(photoFileInput.files[0]);
    }

    await saveStoredSettings({
      customDisplayName,
      customProfilePhotoUrl
    });

    photoFileInput.value = "";
    updateAppearanceInputs({
      customDisplayName,
      customProfilePhotoUrl
    });

    if (!customDisplayName && !customProfilePhotoUrl) {
      setMessage("Appearance overrides cleared for this profile.");
    } else {
      setMessage(
        "Appearance overrides saved. Open Messenger tabs will update automatically."
      );
    }
  } catch (error) {
    setMessage(error.message, true);
  }
});

clearAppearanceButton.addEventListener("click", async () => {
  try {
    displayNameInput.value = "";
    photoUrlInput.value = "";
    photoFileInput.value = "";

    await saveStoredSettings({
      customDisplayName: "",
      customProfilePhotoUrl: ""
    });

    updateAppearanceInputs({
      customDisplayName: "",
      customProfilePhotoUrl: ""
    });

    setMessage("Appearance overrides removed for this profile.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

loadPastedButton.addEventListener("click", async () => {
  try {
    const rawText = scriptEditor.value.trim();

    if (!rawText) {
      setScriptHint("Paste your chat messages first.", "error");
      return;
    }

    let script;
    try {
      script = parseScriptJson(rawText);
    } catch (parseError) {
      setScriptHint("Invalid JSON: " + parseError.message, "error");
      return;
    }

    if (script.length === 0) {
      setScriptHint("JSON array is empty.", "error");
      return;
    }

    await saveStoredSettings();
    await callServer("/script/load", { method: "POST", body: { script } });
    await triggerDispatchNow();
    await refreshState();
    setScriptHint(`Loaded ${script.length} messages.`, "success");
    setMessage("Custom script loaded.");
  } catch (error) {
    setScriptHint(error.message, "error");
  }
});

loadSampleButton.addEventListener("click", async () => {
  try {
    await saveStoredSettings();
    const data = await callServer("/script/load", { method: "POST", body: {} });
    await triggerDispatchNow();

    if (data.state && data.state.script) {
      scriptEditor.value = scriptToText(data.state.script);
      setScriptHint(
        `Loaded ${data.state.script.length} default messages.`,
        "success"
      );
    }

    await refreshState();
    setMessage("Default script loaded.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

startButton.addEventListener("click", async () => {
  try {
    await saveStoredSettings();
    const readyResult = await ensureMessengerReady();
    if (!readyResult || !readyResult.ok) {
      throw new Error(
        readyResult && readyResult.error
          ? readyResult.error
          : "Could not find a ready Messenger tab."
      );
    }

    await callServer("/run/start", { method: "POST", body: {} });
    await triggerDispatchNow();
    await refreshState();
    setMessage("Automation started.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await callServer("/run/stop", { method: "POST", body: {} });
    await triggerDispatchNow();
    await refreshState();
    setMessage("Automation stopped.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

resetButton.addEventListener("click", async () => {
  try {
    await callServer("/reset", { method: "POST", body: {} });
    await triggerDispatchNow();
    await refreshState();
    setMessage("State reset.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

scriptEditor.addEventListener("input", () => {
  const raw = scriptEditor.value.trim();
  if (!raw) {
    setScriptHint("");
    return;
  }

  try {
    const script = parseScriptJson(raw);
    setScriptHint(
      `${script.length} messages detected - click "Load Pasted Script" to use.`
    );
  } catch (error) {
    setScriptHint("Invalid JSON: " + error.message, "error");
  }
});

initializePopup().catch((error) => {
  log("Popup failed to initialize:", error.message);
  setMessage(error.message, true);
});
