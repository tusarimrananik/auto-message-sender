const express = require("express");
const cors = require("cors");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const PORT = 3000;
const SOCKET_PATH = "/ws";
const DISPATCH_TIMEOUT_MS = 45000;
const RETRY_DELAY_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15000;
const SCRIPTS_DIR = path.join(__dirname, "scripts");

function loadScriptFile(name = "default") {
  const safeName = path.basename(name, ".json");
  const filePath = path.join(SCRIPTS_DIR, `${safeName}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Script file "${safeName}.json" not found in scripts directory.`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function listScriptFiles() {
  if (!fs.existsSync(SCRIPTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

const DEFAULT_SAMPLE_SCRIPT = loadScriptFile("default");

function cloneScript(script) {
  return script.map((step) => ({
    sender: step.sender,
    text: step.text
  }));
}

const state = {
  running: false,
  currentStep: 0,
  lastCompletedStep: -1,
  lastProcessedEventId: 0,
  nextSocketId: 1,
  nextDispatchId: 1,
  activeDispatch: null,
  script: cloneScript(DEFAULT_SAMPLE_SCRIPT),
  delayMs: {
    A: 2000,
    B: 3000
  }
};

const workers = new Map();
let dispatchRetryTimeoutId = null;

app.use(cors());
app.use(express.json());

function isValidProfile(profile) {
  return profile === "A" || profile === "B";
}

function isValidScriptStep(step) {
  return (
    step &&
    typeof step === "object" &&
    isValidProfile(step.sender) &&
    typeof step.text === "string" &&
    step.text.trim().length > 0
  );
}

function getCurrentScriptStep() {
  return state.script[state.currentStep] || null;
}

function getProfileWorkerSummary(profile) {
  const connectedWorkers = Array.from(workers.values()).filter((worker) => worker.profile === profile);
  const preferredWorker = getPreferredWorker(profile);

  return {
    connected: connectedWorkers.length > 0,
    connectionCount: connectedWorkers.length,
    lastSeenAt: preferredWorker ? preferredWorker.lastSeenAt : null
  };
}

function buildStateResponse() {
  const current = getCurrentScriptStep();

  return {
    running: state.running,
    currentStep: state.currentStep,
    lastCompletedStep: state.lastCompletedStep,
    lastProcessedEventId: state.lastProcessedEventId,
    script: state.script,
    delayMs: state.delayMs,
    totalSteps: state.script.length,
    finished: state.currentStep >= state.script.length,
    activeDispatch: state.activeDispatch
        ? {
          dispatchId: state.activeDispatch.dispatchId,
          stepIndex: state.activeDispatch.stepIndex,
          profile: state.activeDispatch.profile,
          socketId: state.activeDispatch.socketId,
          createdAt: state.activeDispatch.createdAt
        }
      : null,
    workers: {
      A: getProfileWorkerSummary("A"),
      B: getProfileWorkerSummary("B")
    },
    nextStep: current
      ? {
          index: state.currentStep,
          sender: current.sender,
          text: current.text
        }
      : null
  };
}

function resetProgress() {
  state.running = false;
  state.currentStep = 0;
  state.lastCompletedStep = -1;
  state.lastProcessedEventId = 0;
  clearActiveDispatch();
}

function sendJson(target, payload) {
  const ws = target instanceof WebSocket ? target : target && target.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  ws.send(JSON.stringify(payload));
  return true;
}

function broadcastState() {
  const payload = {
    type: "state_update",
    state: buildStateResponse()
  };

  for (const worker of workers.values()) {
    sendJson(worker, payload);
  }
}

function updateWorkerSeen(worker) {
  worker.lastSeenAt = Date.now();
}

function getPreferredWorker(profile) {
  const matchingWorkers = Array.from(workers.values()).filter((worker) => worker.profile === profile);

  if (matchingWorkers.length === 0) {
    return null;
  }

  matchingWorkers.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  return matchingWorkers[0];
}

function clearDispatchRetry() {
  if (dispatchRetryTimeoutId !== null) {
    clearTimeout(dispatchRetryTimeoutId);
    dispatchRetryTimeoutId = null;
  }
}

function queueDispatch(delayMs = 0) {
  clearDispatchRetry();
  dispatchRetryTimeoutId = setTimeout(() => {
    dispatchRetryTimeoutId = null;
    dispatchNextStep("queued");
  }, delayMs);
}

function clearActiveDispatch() {
  if (state.activeDispatch && state.activeDispatch.timeoutId) {
    clearTimeout(state.activeDispatch.timeoutId);
  }

  state.activeDispatch = null;
}

function failActiveDispatch(reason) {
  if (!state.activeDispatch) {
    return;
  }

  console.log(`[AUTOCHAT] Dispatch ${state.activeDispatch.dispatchId} failed: ${reason}`);
  clearActiveDispatch();
  broadcastState();
  queueDispatch(RETRY_DELAY_MS);
}

function dispatchNextStep(reason = "unknown") {
  if (!state.running || state.activeDispatch) {
    return;
  }

  const current = getCurrentScriptStep();
  if (!current) {
    state.running = false;
    broadcastState();
    return;
  }

  const worker = getPreferredWorker(current.sender);
  if (!worker) {
    return;
  }

  const dispatch = {
    dispatchId: state.nextDispatchId,
    stepIndex: state.currentStep,
    profile: current.sender,
    socketId: worker.socketId,
    createdAt: Date.now(),
    timeoutId: null
  };

  state.nextDispatchId += 1;
  dispatch.timeoutId = setTimeout(() => {
    if (state.activeDispatch && state.activeDispatch.dispatchId === dispatch.dispatchId) {
      failActiveDispatch(`Timed out after ${DISPATCH_TIMEOUT_MS}ms.`);
    }
  }, DISPATCH_TIMEOUT_MS);

  state.activeDispatch = dispatch;

  const sent = sendJson(worker, {
    type: "dispatch_step",
    dispatchId: dispatch.dispatchId,
    stepIndex: dispatch.stepIndex,
    sender: current.sender,
    text: current.text,
    delayMs: state.delayMs[current.sender] || 0
  });

  if (!sent) {
    failActiveDispatch("Selected worker socket was not open.");
    return;
  }

  console.log(
    `[AUTOCHAT] Dispatched step ${dispatch.stepIndex} for profile ${dispatch.profile} ` +
    `to socket ${dispatch.socketId} via ${reason}.`
  );
  broadcastState();
}

function handleWorkerRegistration(worker, message) {
  if (!isValidProfile(message.profile)) {
    sendJson(worker, { type: "error", error: 'Invalid "profile". Use "A" or "B".' });
    return;
  }

  worker.profile = message.profile;
  updateWorkerSeen(worker);

  sendJson(worker, {
    type: "registered",
    socketId: worker.socketId,
    state: buildStateResponse()
  });

  console.log(
    `[AUTOCHAT] Worker ${worker.socketId} registered as profile ${worker.profile}.`
  );

  broadcastState();
  queueDispatch(0);
}

function handleStepResult(worker, message) {
  if (!state.activeDispatch || state.activeDispatch.dispatchId !== message.dispatchId) {
    return;
  }

  if (state.activeDispatch.socketId !== worker.socketId) {
    return;
  }

  const dispatch = state.activeDispatch;

  if (!message.ok) {
    failActiveDispatch(message.error || "Worker reported send failure.");
    return;
  }

  const current = getCurrentScriptStep();
  if (
    !state.running ||
    !current ||
    dispatch.stepIndex !== state.currentStep ||
    dispatch.profile !== current.sender
  ) {
    clearActiveDispatch();
    broadcastState();
    queueDispatch(0);
    return;
  }

  state.lastCompletedStep = state.currentStep;
  state.currentStep += 1;
  state.lastProcessedEventId += 1;
  clearActiveDispatch();

  if (state.currentStep >= state.script.length) {
    state.running = false;
  }

  console.log(
    `[AUTOCHAT] Worker ${worker.socketId} completed step ${dispatch.stepIndex} for profile ${dispatch.profile}.`
  );

  broadcastState();
  queueDispatch(0);
}

function removeWorker(worker) {
  workers.delete(worker.socketId);

  if (state.activeDispatch && state.activeDispatch.socketId === worker.socketId) {
    failActiveDispatch("Assigned worker disconnected.");
  } else {
    broadcastState();
    queueDispatch(0);
  }
}

app.get("/state", (req, res) => {
  res.json({
    ok: true,
    state: buildStateResponse()
  });
});

app.post("/config/profile-delay", (req, res) => {
  const { profile, delayMs } = req.body || {};

  if (!isValidProfile(profile)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid "profile". Use "A" or "B".'
    });
  }

  if (!Number.isInteger(delayMs) || delayMs < 0) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid "delayMs". Use a non-negative integer.'
    });
  }

  state.delayMs[profile] = delayMs;
  broadcastState();
  queueDispatch(0);

  res.json({
    ok: true,
    message: `Delay updated for profile ${profile}.`,
    state: buildStateResponse()
  });
});

app.get("/scripts", (req, res) => {
  try {
    const files = listScriptFiles();
    res.json({ ok: true, scripts: files });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/script/load", (req, res) => {
  let scriptToLoad;

  if (req.body && req.body.file) {
    try {
      scriptToLoad = loadScriptFile(req.body.file);
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message });
    }
  } else if (req.body && Array.isArray(req.body.script)) {
    scriptToLoad = req.body.script;
  } else {
    scriptToLoad = loadScriptFile("default");
  }

  if (!Array.isArray(scriptToLoad) || scriptToLoad.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid "script". Provide a non-empty array.'
    });
  }

  const invalidStepIndex = scriptToLoad.findIndex((step) => !isValidScriptStep(step));
  if (invalidStepIndex !== -1) {
    return res.status(400).json({
      ok: false,
      error: `Invalid script step at index ${invalidStepIndex}. Each step needs sender "A" or "B" and a non-empty text string.`
    });
  }

  state.script = cloneScript(scriptToLoad);
  resetProgress();
  broadcastState();

  res.json({
    ok: true,
    message: "Script loaded and progress reset.",
    state: buildStateResponse()
  });
});

app.post("/run/start", (req, res) => {
  if (state.script.length === 0) {
    return res.status(400).json({
      ok: false,
      error: "Cannot start because no script is loaded."
    });
  }

  if (state.currentStep >= state.script.length) {
    state.currentStep = 0;
    state.lastCompletedStep = -1;
  }

  clearActiveDispatch();
  state.running = true;
  broadcastState();
  queueDispatch(0);

  res.json({
    ok: true,
    message: "Automation started.",
    state: buildStateResponse()
  });
});

app.post("/run/stop", (req, res) => {
  clearActiveDispatch();
  state.running = false;
  broadcastState();

  res.json({
    ok: true,
    message: "Automation stopped.",
    state: buildStateResponse()
  });
});

app.post("/reset", (req, res) => {
  resetProgress();
  broadcastState();

  res.json({
    ok: true,
    message: "State reset to step 0.",
    state: buildStateResponse()
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: SOCKET_PATH });

wss.on("connection", (ws) => {
  const worker = {
    socketId: state.nextSocketId,
    ws,
    profile: null,
    connectedAt: Date.now(),
    lastSeenAt: Date.now()
  };

  state.nextSocketId += 1;
  workers.set(worker.socketId, worker);

  sendJson(worker, {
    type: "welcome",
    socketId: worker.socketId,
    state: buildStateResponse()
  });

  ws.on("message", (buffer) => {
    updateWorkerSeen(worker);

    let message;
    try {
      message = JSON.parse(buffer.toString());
    } catch (error) {
      sendJson(worker, { type: "error", error: "Invalid JSON message." });
      return;
    }

    if (!message || typeof message.type !== "string") {
      sendJson(worker, { type: "error", error: "Message must include a string type." });
      return;
    }

    if (message.type === "register_worker") {
      handleWorkerRegistration(worker, message);
      return;
    }

    if (message.type === "heartbeat_ack") {
      return;
    }

    if (message.type === "step_result") {
      handleStepResult(worker, message);
      return;
    }

    sendJson(worker, { type: "error", error: `Unsupported message type "${message.type}".` });
  });

  ws.on("close", () => {
    removeWorker(worker);
  });

  ws.on("error", (error) => {
    console.log(`[AUTOCHAT] Worker ${worker.socketId} socket error: ${error.message}`);
  });

  broadcastState();
});

setInterval(() => {
  for (const worker of workers.values()) {
    sendJson(worker, {
      type: "heartbeat",
      now: Date.now()
    });
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`[AUTOCHAT] Server running at http://localhost:${PORT}`);
  console.log(`[AUTOCHAT] WebSocket endpoint available at ws://localhost:${PORT}${SOCKET_PATH}`);
});
