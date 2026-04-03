const SERVER_BASE_URL = "http://localhost:3000";
const LOG_PREFIX = "[AUTOCHAT]";

const profileSelect = document.getElementById("profileIdentity");
const loadSampleButton = document.getElementById("loadSampleButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const resetButton = document.getElementById("resetButton");

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

async function getStoredSettings() {
  return chrome.storage.local.get({
    profileIdentity: "A"
  });
}

async function saveStoredSettings() {
  await chrome.storage.local.set({
    profileIdentity: profileSelect.value
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
  workerAStatus.textContent = state.workers && state.workers.A && state.workers.A.connected ? "Online" : "Offline";
  workerBStatus.textContent = state.workers && state.workers.B && state.workers.B.connected ? "Online" : "Offline";
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

  await refreshState();
  setInterval(refreshState, 2000);
}

profileSelect.addEventListener("change", async () => {
  await saveStoredSettings();
  await triggerDispatchNow();
  setMessage(`Saved profile identity: ${profileSelect.value}`);
});

loadSampleButton.addEventListener("click", async () => {
  try {
    await saveStoredSettings();
    await callServer("/script/load", { method: "POST", body: {} });
    await triggerDispatchNow();
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
      throw new Error(readyResult && readyResult.error ? readyResult.error : "Could not find a ready Messenger tab.");
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

initializePopup().catch((error) => {
  log("Popup failed to initialize:", error.message);
  setMessage(error.message, true);
});
