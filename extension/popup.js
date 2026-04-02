const SERVER_BASE_URL = "http://localhost:3000";
const LOG_PREFIX = "[AUTOCHAT]";

const profileSelect = document.getElementById("profileIdentity");
const modeSelect = document.getElementById("siteMode");
const loadSampleButton = document.getElementById("loadSampleButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const resetButton = document.getElementById("resetButton");

const serverStatus = document.getElementById("serverStatus");
const runningStatus = document.getElementById("runningStatus");
const currentStepStatus = document.getElementById("currentStepStatus");
const nextSenderStatus = document.getElementById("nextSenderStatus");
const nextTextStatus = document.getElementById("nextTextStatus");
const messageText = document.getElementById("messageText");

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function setMessage(text, isError = false) {
  messageText.textContent = text;
  messageText.style.color = isError ? "#b91c1c" : "#2563eb";
}

async function getStoredSettings() {
  return chrome.storage.local.get({
    profileIdentity: "A",
    siteMode: "live"
  });
}

async function saveStoredSettings() {
  await chrome.storage.local.set({
    profileIdentity: profileSelect.value,
    siteMode: modeSelect.value
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

async function ensurePageInjection() {
  return chrome.runtime.sendMessage({ type: "AUTOCHAT_ENSURE_INJECTION" });
}

function renderState(state) {
  serverStatus.textContent = "Connected";
  runningStatus.textContent = state.running ? "Yes" : "No";
  currentStepStatus.textContent = `${state.currentStep} / ${state.totalSteps}`;
  nextSenderStatus.textContent = state.nextStep ? state.nextStep.sender : "None";
  nextTextStatus.textContent = state.nextStep ? state.nextStep.text : "Finished";
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
    setMessage(error.message, true);
  }
}

async function initializePopup() {
  const settings = await getStoredSettings();
  profileSelect.value = settings.profileIdentity;
  modeSelect.value = settings.siteMode;

  await refreshState();
  setInterval(refreshState, 2000);
}

profileSelect.addEventListener("change", async () => {
  await saveStoredSettings();
  setMessage(`Saved profile identity: ${profileSelect.value}`);
});

modeSelect.addEventListener("change", async () => {
  await saveStoredSettings();
  setMessage(`Saved mode: ${modeSelect.value}`);
});

loadSampleButton.addEventListener("click", async () => {
  try {
    await saveStoredSettings();
    await callServer("/script/load", { method: "POST", body: {} });
    await refreshState();
    setMessage("Sample script loaded.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

startButton.addEventListener("click", async () => {
  try {
    await saveStoredSettings();
    const injectionResult = await ensurePageInjection();
    if (!injectionResult || !injectionResult.ok) {
      throw new Error(injectionResult && injectionResult.error ? injectionResult.error : "Could not inject into the current chat tab.");
    }

    await callServer("/run/start", { method: "POST", body: {} });
    await refreshState();
    setMessage("Automation started and page injection checked.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await callServer("/run/stop", { method: "POST", body: {} });
    await refreshState();
    setMessage("Automation stopped.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

resetButton.addEventListener("click", async () => {
  try {
    await callServer("/reset", { method: "POST", body: {} });
    await refreshState();
    setMessage("State reset.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

initializePopup().catch((error) => {
  log("Popup failed to initialize:", error.message);
  setMessage(error.message, true);
});
