// The Friction Layer - content script for chatgpt.com and claude.ai.
// Intercepts message submission, shows the friction card, releases the held
// message when the card clears. All UI lives in a shadow root so site CSS
// can't touch it.

(() => {
  "use strict";

  // -------------------------------------------------------------------------
  // Site adapters - exact support for two sites only
  // -------------------------------------------------------------------------

  const host = location.hostname;
  const site = host.endsWith("chatgpt.com")
    ? "chatgpt"
    : host.endsWith("claude.ai")
      ? "claude"
      : null;
  if (!site) return;

  const adapters = {
    chatgpt: {
      getEditor() {
        return (
          document.querySelector("#prompt-textarea") ||
          document.querySelector("form textarea")
        );
      },
      getSendButton() {
        return (
          document.querySelector("#composer-submit-button") ||
          document.querySelector('button[data-testid="send-button"]')
        );
      },
      getMessages() {
        const nodes = document.querySelectorAll("[data-message-author-role]");
        return Array.from(nodes).map((n) => ({
          role: n.getAttribute("data-message-author-role"),
          text: (n.innerText || "").trim(),
        }));
      },
    },
    claude: {
      getEditor() {
        return (
          document.querySelector('div.ProseMirror[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"]')
        );
      },
      getSendButton() {
        const buttons = document.querySelectorAll("button[aria-label]");
        for (const b of buttons) {
          const label = (b.getAttribute("aria-label") || "").toLowerCase();
          if (label.includes("send message") || label === "send") return b;
        }
        return null;
      },
      getMessages() {
        const nodes = document.querySelectorAll(
          '[data-testid="user-message"], .font-claude-message, .font-claude-response'
        );
        return Array.from(nodes).map((n) => ({
          role: n.matches('[data-testid="user-message"]') ? "user" : "assistant",
          text: (n.innerText || "").trim(),
        }));
      },
    },
  };

  const adapter = adapters[site];

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  const DEFAULT_SETTINGS = { enabled: true, intensity: "standard", timerSeconds: 30 };
  let settings = { ...DEFAULT_SETTINGS };

  chrome.storage.local.get("settings").then(({ settings: s }) => {
    if (s) settings = { ...DEFAULT_SETTINGS, ...s };
  });
  chrome.storage.local.onChanged.addListener((changes) => {
    if (changes.settings && changes.settings.newValue) {
      settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    }
  });

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let state = "idle"; // idle | loading | question | closing
  let bypassUntil = 0; // while Date.now() < bypassUntil, interception is off
  let heldMessage = "";
  let currentRecord = null;
  let rejectedCount = 0;

  let overlayHost = null;
  let overlayShadow = null;
  let timerRaf = null;
  let timerDone = false;

  let chipHost = null;
  let chipTimeout = null;

  function sendToBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError; // swallow "no receiver" errors
          resolve(resp);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  function log(entry) {
    entry.ts = entry.ts || new Date().toISOString();
    entry.site = site;
    sendToBackground({ type: "log", entry });
  }

  function finishLog() {
    if (!currentRecord) return;
    log(currentRecord);
    currentRecord = null;
  }

  // -------------------------------------------------------------------------
  // Editor helpers
  // -------------------------------------------------------------------------

  function getEditorText() {
    const ed = adapter.getEditor();
    if (!ed) return "";
    return ed.tagName === "TEXTAREA" ? ed.value : ed.innerText || "";
  }

  function setEditorText(text) {
    const ed = adapter.getEditor();
    if (!ed) return;
    ed.focus();
    if (ed.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      ).set;
      setter.call(ed, text);
      ed.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }
  }

  function triggerSend() {
    const btn = adapter.getSendButton();
    if (btn && !btn.disabled) {
      btn.click();
      return;
    }
    const ed = adapter.getEditor();
    if (ed) {
      ed.focus();
      ed.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  // Release the held message to the page. If finalText is provided the input
  // box is rewritten first (append-answer mode); otherwise the message goes
  // through exactly as the user typed it.
  function releaseMessage(finalText) {
    state = "idle";
    bypassUntil = Date.now() + 3000;
    if (finalText != null) {
      setEditorText(finalText);
      setTimeout(triggerSend, 150);
    } else {
      triggerSend();
    }
  }

  // -------------------------------------------------------------------------
  // Gentle-mode session window + thread memory
  // -------------------------------------------------------------------------

  async function inGentleWindow() {
    const key = "session_" + site;
    const now = Date.now();
    const stored = (await chrome.storage.local.get(key))[key];
    let session = stored;
    if (!session || now - session.last > 30 * 60 * 1000) {
      session = { start: now, last: now };
    } else {
      session.last = now;
    }
    await chrome.storage.local.set({ [key]: session });
    return now - session.start <= 10 * 60 * 1000;
  }

  const RECENT_KEY = "fl-recent:" + location.pathname;

  function getRecentFriction() {
    try {
      const raw = sessionStorage.getItem(RECENT_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (Date.now() - data.at > 20 * 60 * 1000) return null;
      return data;
    } catch (_e) {
      return null;
    }
  }

  function setRecentFriction(data) {
    try {
      sessionStorage.setItem(RECENT_KEY, JSON.stringify({ ...data, at: Date.now() }));
    } catch (_e) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Fonts
  // -------------------------------------------------------------------------

  function ensureFont() {
    if (document.getElementById("friction-layer-font")) return;
    const link = document.createElement("link");
    link.id = "friction-layer-font";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap";
    (document.head || document.documentElement).appendChild(link);
  }

  // -------------------------------------------------------------------------
  // Friction card UI
  // -------------------------------------------------------------------------

  const CARD_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .backdrop {
      position: fixed; inset: 0;
      z-index: 2147483644;
      backdrop-filter: blur(5px);
      -webkit-backdrop-filter: blur(5px);
      background: rgba(0, 0, 0, 0.08);
      opacity: 0;
      transition: opacity 250ms ease;
    }
    .card {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      width: min(620px, calc(100vw - 48px));
      z-index: 2147483645;
      background: #FFFFFF;
      color: #333333;
      border-radius: 0;
      padding: 24px 30px 26px;
      box-shadow: 0 20px 55px rgba(0, 0, 0, 0.22), 0 2px 0 rgba(0, 0, 0, 0.9);
      font-family: "EB Garamond", Garamond, Georgia, serif;
      font-size: 16px;
      line-height: 1.45;
      opacity: 0;
      transition: opacity 250ms ease;
    }
    .visible .backdrop, .card.visible { opacity: 1; }
    .fading .backdrop, .card.fading { opacity: 0 !important; transition: opacity 200ms ease; }
    .label {
      font-size: 11px;
      letter-spacing: 0.16em;
      color: #000000;
      font-weight: 600;
      margin-bottom: 12px;
    }
    .rule {
      border: none;
      border-top: 2px solid #000000;
      margin: 0 0 12px;
    }
    .rule.below { margin-top: 16px; }
    .preview {
      color: #333333;
      font-style: italic;
      font-size: 14px;
      margin-bottom: 14px;
      max-height: 4.5em;
      overflow: hidden;
    }
    .question {
      color: #000000;
      font-style: italic;
      font-size: 18px;
      min-height: 26px;
      margin-bottom: 4px;
    }
    .loading-space { min-height: 56px; }
    .answer {
      display: block;
      width: 100%;
      background: transparent;
      border: none;
      border-bottom: 2px solid #000000;
      border-radius: 2px;
      font-family: "EB Garamond", Garamond, Georgia, serif;
      font-size: 16px;
      color: #000000;
      padding: 8px 2px;
      margin-bottom: 18px;
      outline: none;
    }
    .answer::placeholder { color: #333333; opacity: 0.55; font-style: italic; }
    .controls {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 13.5px;
      color: #333333;
      cursor: pointer;
      user-select: none;
      flex: 1;
    }
    .toggle input { accent-color: #000000; width: 14px; height: 14px; cursor: pointer; }
    .timer {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .timer svg { transform: rotate(-90deg); }
    .timer .track { stroke: #000000; stroke-width: 1.5; }
    .timer .arc { stroke: #000000; stroke-width: 3; transition: stroke-dashoffset 120ms linear; }
    .count {
      font-size: 13.5px;
      font-variant-numeric: tabular-nums;
      color: #000000;
      min-width: 34px;
    }
    .continue {
      position: relative;
      background: #000000;
      color: #FFFFFF;
      border: none;
      border-radius: 2px;
      font-family: "EB Garamond", Garamond, Georgia, serif;
      font-size: 15px;
      letter-spacing: 0.04em;
      padding: 9px 22px;
      cursor: pointer;
      transition: transform 160ms ease, box-shadow 160ms ease;
    }
    .continue::after {
      content: "";
      position: absolute;
      left: 0; bottom: -4px;
      height: 2px; width: 100%;
      background: #000000;
      transform: scaleX(0);
      transform-origin: left;
      transition: transform 220ms ease;
    }
    .continue:not(:disabled):hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 22px rgba(0, 0, 0, 0.28);
    }
    .continue:not(:disabled):hover::after { transform: scaleX(1); }
    .continue:disabled { opacity: 0.4; cursor: default; }
    .feedback {
      margin-top: 12px;
      font-style: italic;
      font-size: 14px;
      color: #333333;
      min-height: 0;
    }
    .hidden { display: none; }
  `;

  function positionCard(card) {
    const ed = adapter.getEditor();
    let bottom = 140;
    if (ed) {
      const rect = ed.getBoundingClientRect();
      bottom = Math.max(24, window.innerHeight - rect.top + 16);
    }
    // Keep the card on screen even for tall content.
    bottom = Math.min(bottom, window.innerHeight - 120);
    card.style.bottom = bottom + "px";
  }

  function showLoadingCard() {
    ensureFont();
    removeOverlay();
    overlayHost = document.createElement("div");
    overlayHost.id = "friction-layer-overlay";
    overlayShadow = overlayHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = CARD_CSS;
    overlayShadow.appendChild(style);

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    overlayShadow.appendChild(backdrop);

    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "dialog");
    card.innerHTML = `
      <div class="label">the friction layer</div>
      <hr class="rule">
      <div class="preview hidden"></div>
      <div class="loading-space"></div>
      <div class="question hidden"></div>
      <hr class="rule below">
      <div class="qa hidden">
        <input class="answer" type="text" maxlength="500"
               placeholder="One sentence of your own thinking">
        <div class="controls">
          <label class="toggle">
            <input type="checkbox" class="append" checked>
            <span>Append my answer to the message</span>
          </label>
          <div class="timer">
            <svg width="26" height="26" viewBox="0 0 26 26">
              <circle class="track" cx="13" cy="13" r="10.5" fill="none" stroke-width="2.5"></circle>
              <circle class="arc" cx="13" cy="13" r="10.5" fill="none" stroke-width="2.5"
                      stroke-linecap="butt"></circle>
            </svg>
            <span class="count"></span>
          </div>
          <button class="continue" disabled>Continue</button>
        </div>
        <div class="feedback"></div>
      </div>
    `;
    overlayShadow.appendChild(card);
    document.documentElement.appendChild(overlayHost);
    positionCard(card);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        card.classList.add("visible");
        backdrop.style.opacity = "1";
      });
    });
  }

  function showQuestion(question) {
    if (!overlayShadow) return;
    state = "question";
    timerDone = false;
    rejectedCount = 0;

    const card = overlayShadow.querySelector(".card");
    overlayShadow.querySelector(".loading-space").classList.add("hidden");

    const preview = overlayShadow.querySelector(".preview");
    preview.textContent = heldMessage;
    preview.classList.remove("hidden");

    const q = overlayShadow.querySelector(".question");
    q.textContent = question;
    q.classList.remove("hidden");

    overlayShadow.querySelector(".qa").classList.remove("hidden");

    const answer = overlayShadow.querySelector(".answer");
    const continueBtn = overlayShadow.querySelector(".continue");
    const countEl = overlayShadow.querySelector(".count");
    const arc = overlayShadow.querySelector(".arc");

    const R = 10.5;
    const CIRC = 2 * Math.PI * R;
    arc.setAttribute("stroke-dasharray", String(CIRC));
    arc.setAttribute("stroke-dashoffset", "0");

    const total = Math.max(5, Math.min(60, settings.timerSeconds || 30)) * 1000;
    const startedAt = Date.now();

    function updateContinue() {
      continueBtn.disabled = !(timerDone && answer.value.trim().length > 0);
    }

    function tick() {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, total - elapsed);
      const secs = Math.ceil(remaining / 1000);
      countEl.textContent =
        Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
      arc.setAttribute("stroke-dashoffset", String(CIRC * (elapsed / total)));
      if (remaining <= 0) {
        timerDone = true;
        arc.setAttribute("stroke-dashoffset", String(CIRC));
        countEl.textContent = "0:00";
        updateContinue();
        timerRaf = null;
        return;
      }
      timerRaf = requestAnimationFrame(tick);
    }
    timerRaf = requestAnimationFrame(tick);

    answer.addEventListener("input", updateContinue);
    answer.addEventListener("keydown", (e) => {
      // Keep card keystrokes away from the page; allow Enter to mean Continue.
      e.stopPropagation();
      if (e.key === "Enter" && !continueBtn.disabled) onContinue();
      if (e.key === "Escape") dismissWithEscape();
    });
    continueBtn.addEventListener("click", onContinue);
    setTimeout(() => answer.focus(), 300);
    positionCard(card);
  }

  async function onContinue() {
    if (state !== "question" || !overlayShadow) return;
    const answerInput = overlayShadow.querySelector(".answer");
    const continueBtn = overlayShadow.querySelector(".continue");
    const feedbackEl = overlayShadow.querySelector(".feedback");
    const answer = answerInput.value.trim();
    if (!answer || !timerDone) return;

    continueBtn.disabled = true;
    continueBtn.textContent = "Checking…";

    const resp = await sendToBackground({
      type: "effortCheck",
      payload: {
        question: currentRecord ? currentRecord.question : "",
        answer,
        message: heldMessage,
      },
    });
    if (state !== "question") return; // dismissed while checking

    const attempt = { answer, ts: new Date().toISOString() };

    if (!resp || !resp.ok) {
      attempt.genuine = null;
      attempt.note = "effort-check API failure, failed open";
      if (currentRecord) {
        currentRecord.attempts.push(attempt);
        currentRecord.failOpen = true;
        currentRecord.accepted = true;
      }
      acceptAndRelease(answer);
      return;
    }

    attempt.genuine = resp.result.genuine;
    attempt.feedback = resp.result.feedback || "";
    if (currentRecord) currentRecord.attempts.push(attempt);

    if (resp.result.genuine) {
      if (currentRecord) currentRecord.accepted = true;
      acceptAndRelease(answer);
      return;
    }

    rejectedCount += 1;
    if (rejectedCount >= 2) {
      if (currentRecord) {
        currentRecord.accepted = false;
        currentRecord.forcedThrough = true;
      }
      acceptAndRelease(answer);
      return;
    }

    feedbackEl.textContent =
      resp.result.feedback ||
      "Give it one more honest pass. What do you actually think?";
    continueBtn.textContent = "Continue";
    continueBtn.disabled = false;
    answerInput.focus();
  }

  function acceptAndRelease(answer) {
    const appendOn = overlayShadow
      ? overlayShadow.querySelector(".append").checked
      : true;
    if (currentRecord) {
      currentRecord.appendOn = appendOn;
      setRecentFriction({
        message: heldMessage,
        question: currentRecord.question || "",
        answer,
      });
    }
    finishLog();
    const finalText = appendOn
      ? `[My own thinking before asking: ${answer}]\n\n${heldMessage}`
      : null;
    fadeOutOverlay(() => releaseMessage(finalText));
  }

  function dismissWithEscape() {
    if (state !== "loading" && state !== "question") return;
    state = "closing";
    if (currentRecord) {
      currentRecord.dismissed = true;
      if (!currentRecord.outcome) currentRecord.outcome = "dismissed during loading";
      finishLog();
    } else {
      log({ kind: "classified", message: heldMessage, dismissed: true, outcome: "dismissed" });
    }
    fadeOutOverlay(() => releaseMessage(null));
  }

  function fadeOutOverlay(done) {
    state = "closing";
    if (timerRaf) {
      cancelAnimationFrame(timerRaf);
      timerRaf = null;
    }
    if (!overlayShadow) {
      done();
      return;
    }
    const card = overlayShadow.querySelector(".card");
    const backdrop = overlayShadow.querySelector(".backdrop");
    if (card) card.classList.add("fading");
    if (backdrop) {
      backdrop.classList.add("fading");
      backdrop.style.opacity = "0";
    }
    setTimeout(() => {
      removeOverlay();
      done();
    }, 210);
  }

  function removeOverlay() {
    if (timerRaf) {
      cancelAnimationFrame(timerRaf);
      timerRaf = null;
    }
    if (overlayHost) {
      overlayHost.remove();
      overlayHost = null;
      overlayShadow = null;
    }
  }

  // -------------------------------------------------------------------------
  // Nudge chip
  // -------------------------------------------------------------------------

  const CHIP_CSS = `
    :host { all: initial; }
    .chip {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483645;
      background: #FFFFFF;
      color: #333333;
      border-left: 3px solid #333333;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
      font-family: "EB Garamond", Garamond, Georgia, serif;
      font-style: italic;
      font-size: 14.5px;
      line-height: 1.4;
      padding: 10px 16px;
      max-width: min(480px, calc(100vw - 48px));
      opacity: 0;
      transition: opacity 250ms ease;
    }
  `;

  function showNudgeChip(text) {
    removeChip();
    ensureFont();
    chipHost = document.createElement("div");
    chipHost.id = "friction-layer-chip";
    const shadow = chipHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CHIP_CSS;
    shadow.appendChild(style);
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = text;
    shadow.appendChild(chip);
    document.documentElement.appendChild(chipHost);

    const ed = adapter.getEditor();
    let bottom = 150;
    if (ed) {
      const rect = ed.getBoundingClientRect();
      bottom = Math.max(24, window.innerHeight - rect.top + 16);
    }
    chip.style.bottom = Math.min(bottom, window.innerHeight - 80) + "px";

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chip.style.opacity = "1";
      });
    });

    chipTimeout = setTimeout(removeChipWithFade, 6000);
    setTimeout(() => {
      document.addEventListener("click", onAnyClickWhileChip, true);
    }, 400);
  }

  function onAnyClickWhileChip() {
    removeChipWithFade();
  }

  function removeChipWithFade() {
    if (!chipHost) return;
    const chip = chipHost.shadowRoot && chipHost.shadowRoot.querySelector(".chip");
    if (chip) chip.style.opacity = "0";
    setTimeout(removeChip, 260);
  }

  function removeChip() {
    if (chipTimeout) {
      clearTimeout(chipTimeout);
      chipTimeout = null;
    }
    document.removeEventListener("click", onAnyClickWhileChip, true);
    if (chipHost) {
      chipHost.remove();
      chipHost = null;
    }
  }

  // -------------------------------------------------------------------------
  // Submission flow
  // -------------------------------------------------------------------------

  async function handleSubmit() {
    const text = getEditorText().trim();
    if (!text) {
      releaseMessage(null);
      return;
    }
    // Claim the state immediately so a second Enter during the async checks
    // below can't start a parallel flow. Early-exit paths release, which
    // resets state to idle.
    state = "loading";
    heldMessage = text;

    const wordCount = text.split(/\s+/).length;
    if (wordCount < 3) {
      log({ kind: "skip", message: text, outcome: "skipped, too short" });
      releaseMessage(null);
      return;
    }

    if (settings.intensity === "gentle") {
      let within = true;
      try {
        within = await inGentleWindow();
      } catch (_e) {
        within = true;
      }
      if (!within) {
        log({
          kind: "classified",
          message: text,
          outcome: "let through",
          reason: "gentle mode: outside the first 10 minutes of this session",
        });
        releaseMessage(null);
        return;
      }
    }

    rejectedCount = 0;
    const context = adapter.getMessages().slice(-10);
    currentRecord = {
      kind: "classified",
      message: text,
      context,
      attempts: [],
      appendOn: true,
    };

    showLoadingCard();

    const resp = await sendToBackground({
      type: "classify",
      payload: {
        site,
        message: text,
        context,
        recentFriction: getRecentFriction(),
      },
    });

    if (state !== "loading") return; // dismissed with Escape while waiting

    if (!resp || !resp.ok) {
      currentRecord.failOpen = true;
      currentRecord.outcome = "let through";
      currentRecord.reason =
        "API failure or timeout (" + (resp ? resp.error : "no response") + "), failed open";
      finishLog();
      fadeOutOverlay(() => releaseMessage(null));
      return;
    }

    const r = resp.result;
    currentRecord.outcome = r.outcome;
    currentRecord.reason = r.reason;

    if (r.outcome === "full") {
      currentRecord.category = r.category;
      currentRecord.question = r.question;
      showQuestion(r.question);
    } else if (r.outcome === "nudge") {
      currentRecord.nudge = r.nudge;
      finishLog();
      const nudgeText = r.nudge;
      fadeOutOverlay(() => {
        releaseMessage(null);
        showNudgeChip(nudgeText);
      });
    } else {
      finishLog();
      fadeOutOverlay(() => releaseMessage(null));
    }
  }

  // -------------------------------------------------------------------------
  // Interception
  // -------------------------------------------------------------------------

  function eventInsideOverlay(e) {
    if (!overlayHost) return false;
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(overlayHost);
  }

  function onKeydown(e) {
    if (e.key === "Escape" && (state === "loading" || state === "question")) {
      e.preventDefault();
      e.stopImmediatePropagation();
      dismissWithEscape();
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    if (!settings.enabled) return;
    if (Date.now() < bypassUntil) return;
    if (eventInsideOverlay(e)) return;

    const editor = adapter.getEditor();
    if (!editor) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.includes(editor)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    if (state === "idle") handleSubmit();
  }

  function onClick(e) {
    if (!settings.enabled) return;
    if (Date.now() < bypassUntil) return;
    if (eventInsideOverlay(e)) return;

    const btn = adapter.getSendButton();
    if (!btn) return;
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (!path.some((n) => n === btn)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    if (state === "idle") handleSubmit();
  }

  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("click", onClick, true);
})();
