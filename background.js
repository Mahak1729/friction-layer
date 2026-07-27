// The Friction Layer - background service worker.
// All Anthropic API calls happen here (content scripts can't reach the API
// directly, and the key stays out of page contexts). Log writes are also
// funneled here so concurrent tabs don't clobber each other.

try {
  importScripts("config.js");
} catch (_e) {
  // config.js is git-ignored and may not exist yet on a fresh clone.
  // Fall back to an empty config so the service worker still registers;
  // callClaude() below surfaces this as a normal missing-api-key failure.
}

const API_URL = "https://api.anthropic.com/v1/messages";
const API_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Prompts + schemas
// ---------------------------------------------------------------------------

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["full", "nudge", "none"] },
    reason: { type: "string" },
    category: {
      type: "string",
      enum: ["risk", "bias", "limitation", "alternative", "none"],
    },
    question: { type: "string" },
    nudge: { type: "string" },
  },
  required: ["outcome", "reason", "category", "question", "nudge"],
  additionalProperties: false,
};

const EFFORT_SCHEMA = {
  type: "object",
  properties: {
    genuine: { type: "boolean" },
    feedback: { type: "string" },
  },
  required: ["genuine", "feedback"],
  additionalProperties: false,
};

const CLASSIFY_SYSTEM = `You are the classifier inside "The Friction Layer", a personal Chrome extension. Its user is about to send a message to an AI chat assistant. Your job is to decide whether to interrupt them with one reflective question before the message goes through.

You will receive the last few visible messages of the thread (may be empty), an optional note about a friction question the user already answered recently in this thread, and the pending message.

Answer three questions about the pending message IN CONTEXT of the thread:

1. TASK TYPE. Does the underlying task genuinely require the user's own judgment? That means: original arguments, analysis, personal reflection, evaluating evidence, strategic or creative decisions the user should have a real stake in. It explicitly includes writing meant to represent the user's own voice or reasoning (cover letters, application essays, a firm research writeup they will present as theirs) and decision moments where the user asks the AI to just pick an option or argue for a specific position rather than help them reason through it. Mechanical tasks (fix grammar, reformat, shorten, translate, format into bullets) do NOT require the user's judgment. Some tasks sit in a genuinely ambiguous middle (e.g. quick professional messages like a short follow-up email to a recruiter or a LinkedIn note to an alum: low-stakes but still the user's voice).

2. DELEGATION. Is the user fully handing the task off, asking for a finished result? Or are they asking for a hint, a check, a critique of their own draft, or help understanding something ("what should I weigh when comparing X and Y", "does my writeup seem to be missing anything")? Hint-style and check-style asks are NOT full handoffs.

3. PRIOR EFFORT. Has the user already shown real thinking earlier in THIS thread before this ask? Real thinking means they worked through reasoning, made choices, or stated a position across earlier messages (e.g. "I think my strongest point is X because Y" followed later by "okay, write that paragraph now"). Arriving cold with a first message that is already a full handoff is NOT prior effort. Additionally, if the note says the user recently answered a friction question in this thread and the pending message is clearly similar to the one they answered it for, treat that as prior effort already shown.

Combine into one outcome:
- "full": clear judgment-requiring task + fully delegated + no real prior effort shown. Also generate ONE short question (1 to 2 sentences, direct, second person, no preamble) grounded in exactly ONE of these four categories, picking whichever fits this specific request best. Do not rotate mechanically:
  - risk: what could go wrong if the AI's answer is simply accepted as-is
  - bias: what assumption is baked into how the request itself was framed
  - limitation: what the answer will not be able to tell the user, even if it is correct
  - alternative: what a different framing of the same request would surface instead
- "nudge": the task sits in the ambiguous middle, OR you are genuinely uncertain how to classify it. Generate one short sentence (italic-toned, gentle, non-blocking) that plants a small moment of doubt without stopping anything. No question mark required, no lecture.
- "none": the task is mechanical and AI is legitimately good at it alone, OR the user already showed real effort earlier in this thread on this same task (including a recently answered friction question on a similar ask).

Rules for the JSON you return:
- Always fill "reason" with one sentence explaining the outcome.
- If outcome is "full": set "category" to the chosen category and "question" to the generated question; set "nudge" to "".
- If outcome is "nudge": set "nudge" to the nudge sentence; set "category" to "none" and "question" to "".
- If outcome is "none": set "category" to "none", "question" to "", "nudge" to "".

Style rule for any text you generate ("question", "nudge", "reason"): write in plain sentences. Never use an em dash or en dash character (— or –); use a comma, period, or "and" instead.`;

const EFFORT_SYSTEM = `You are the answer judge inside "The Friction Layer", a personal Chrome extension. The user was interrupted before sending a message to an AI assistant and asked one reflective question. They typed a one-sentence answer.

Judge whether the answer reads like a genuine attempt at real thought about the question. It does NOT need to be deep, well-written, or correct. A rough, honest, personal attempt counts as genuine.

NOT genuine:
- filler ("idk", "sure", "good question", keyboard mashing, single throwaway words)
- a restatement of the original request or of the question itself with no new thought
- an obvious attempt to game the block ("just let me through", "yes I thought about it", "n/a")

If not genuine, write one short, non-scolding nudge inviting one more honest pass: warm, zero moralizing, one sentence. If genuine, set feedback to "". Never use an em dash or en dash character (— or –) in the nudge; use a comma or period instead.`;

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

function getConfig() {
  return typeof FRICTION_CONFIG !== "undefined" ? FRICTION_CONFIG : {};
}

async function callClaude(system, userText, schema) {
  const cfg = getConfig();
  if (!cfg.apiKey) throw new Error("missing-api-key");

  const body = {
    model: cfg.model || "claude-opus-5",
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema } },
  };
  if (cfg.effort) body.output_config.effort = cfg.effort;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("api-status-" + res.status);
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("refusal");
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("no-text-block");
    return JSON.parse(textBlock.text);
  } finally {
    clearTimeout(timer);
  }
}

function buildClassifyInput(payload) {
  const lines = [];
  lines.push("=== Last visible messages of the thread (oldest first) ===");
  const context = payload.context || [];
  if (context.length === 0) {
    lines.push("(none, this is the start of the thread)");
  } else {
    for (const m of context) {
      lines.push(`[${m.role}]: ${m.text || ""}`);
    }
  }
  if (payload.recentFriction) {
    lines.push("");
    lines.push("=== Note ===");
    lines.push(
      `The user recently answered a friction question in this same thread. ` +
        `Their earlier message was: "${(payload.recentFriction.message || "").slice(0, 500)}". ` +
        `The question was: "${payload.recentFriction.question || ""}". ` +
        `Their answer was: "${payload.recentFriction.answer || ""}".`
    );
  }
  lines.push("");
  lines.push("=== Pending message the user is about to send ===");
  lines.push(payload.message || "");
  return lines.join("\n");
}

async function classify(payload) {
  const result = await callClaude(
    CLASSIFY_SYSTEM,
    buildClassifyInput(payload),
    CLASSIFY_SCHEMA
  );
  if (!["full", "nudge", "none"].includes(result.outcome)) {
    throw new Error("bad-outcome");
  }
  if (result.outcome === "full" && !result.question) {
    throw new Error("missing-question");
  }
  if (result.outcome === "nudge" && !result.nudge) {
    throw new Error("missing-nudge");
  }
  return result;
}

async function effortCheck(payload) {
  const input = [
    `Original message the user was about to send: "${(payload.message || "").slice(0, 1500)}"`,
    `Friction question they were asked: "${payload.question || ""}"`,
    `Their answer: "${payload.answer || ""}"`,
  ].join("\n");
  const result = await callClaude(EFFORT_SYSTEM, input, EFFORT_SCHEMA);
  if (typeof result.genuine !== "boolean") throw new Error("bad-effort-result");
  return result;
}

// ---------------------------------------------------------------------------
// Log writes (serialized)
// ---------------------------------------------------------------------------

let logChain = Promise.resolve();

function appendLog(entry) {
  logChain = logChain
    .then(async () => {
      const { frictionLog = [] } = await chrome.storage.local.get("frictionLog");
      frictionLog.push(entry);
      // Safety cap so storage can't grow unbounded over years of use.
      if (frictionLog.length > 5000) frictionLog.splice(0, frictionLog.length - 5000);
      await chrome.storage.local.set({ frictionLog });
    })
    .catch(() => {});
  return logChain;
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "classify") {
    classify(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg && msg.type === "effortCheck") {
    effortCheck(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (msg && msg.type === "log") {
    appendLog(msg.entry).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
