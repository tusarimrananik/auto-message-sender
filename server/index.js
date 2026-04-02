const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = 3000;

const DEFAULT_SAMPLE_SCRIPT = [
  { sender: "A", text: "Hi" },
  { sender: "B", text: "Hello" },
  { sender: "B", text: "How are you?" },
  { sender: "A", text: "Good" }
];

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
  script: cloneScript(DEFAULT_SAMPLE_SCRIPT),
  delayMs: {
    A: 2000,
    B: 3000
  }
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

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

  res.json({
    ok: true,
    message: `Delay updated for profile ${profile}.`,
    state: buildStateResponse()
  });
});

app.post("/script/load", (req, res) => {
  const incomingScript = req.body && req.body.script;
  const scriptToLoad = Array.isArray(incomingScript)
    ? incomingScript
    : DEFAULT_SAMPLE_SCRIPT;

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

  state.running = true;

  res.json({
    ok: true,
    message: "Automation started.",
    state: buildStateResponse()
  });
});

app.post("/run/stop", (req, res) => {
  state.running = false;

  res.json({
    ok: true,
    message: "Automation stopped.",
    state: buildStateResponse()
  });
});

app.post("/step/complete", (req, res) => {
  const { stepIndex, profile } = req.body || {};

  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid "stepIndex". Use a non-negative integer.'
    });
  }

  if (!isValidProfile(profile)) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid "profile". Use "A" or "B".'
    });
  }

  if (!state.running) {
    return res.status(409).json({
      ok: false,
      error: "Automation is not running.",
      state: buildStateResponse()
    });
  }

  const current = getCurrentScriptStep();

  if (!current) {
    state.running = false;
    return res.status(409).json({
      ok: false,
      error: "Script is already finished.",
      state: buildStateResponse()
    });
  }

  if (stepIndex !== state.currentStep) {
    return res.status(409).json({
      ok: false,
      error: `Step mismatch. Server expects step ${state.currentStep}.`,
      state: buildStateResponse()
    });
  }

  if (current.sender !== profile) {
    return res.status(409).json({
      ok: false,
      error: `Profile mismatch. Current step belongs to ${current.sender}.`,
      state: buildStateResponse()
    });
  }

  state.lastCompletedStep = state.currentStep;
  state.currentStep += 1;
  state.lastProcessedEventId += 1;

  if (state.currentStep >= state.script.length) {
    state.running = false;
  }

  res.json({
    ok: true,
    message: "Step completed.",
    state: buildStateResponse()
  });
});

app.post("/reset", (req, res) => {
  resetProgress();

  res.json({
    ok: true,
    message: "State reset to step 0.",
    state: buildStateResponse()
  });
});

app.listen(PORT, () => {
  console.log(`[AUTOCHAT] Server running at http://localhost:${PORT}`);
  console.log(`[AUTOCHAT] Test page available at http://localhost:${PORT}/test-chat.html`);
});
