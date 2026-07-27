# The Friction Layer

A personal Chrome extension for one user. It watches for the moment you ask an
AI tool to fully do a piece of thinking that requires your own judgment, and at
that moment it interrupts with one question before letting your message through.
Everywhere else it stays completely silent.

Supported sites: **chatgpt.com** and **claude.ai**, nothing else, by design.

---

## How to load it

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select this folder (`friction-layer`).
4. The extension appears in the toolbar (pin it via the puzzle-piece icon if
   you want quick access to settings).

After editing any file in this folder (including `config.js`), click the
**reload** icon on the extension's card in `chrome://extensions` to pick up
the change.

## Where to put your Anthropic API key

Copy the template and fill in your key:

```bash
cp config.example.js config.js
```

Then open **`config.js`** and paste your key between the quotes:

```js
const FRICTION_CONFIG = {
  apiKey: "sk-ant-...",   // paste here
  model: "claude-opus-5",
  effort: "low",
};
```

The key stays in this folder on your machine. It is read only by the
extension's background worker and sent only to `api.anthropic.com`.
`config.js` is listed in `.gitignore`, so it never gets committed even if you
push this folder to GitHub; `config.example.js` (the placeholder template) is
the only version that's tracked.

The classifier defaults to `claude-opus-5` with low reasoning effort so the
interruption stays fast. If you want an even faster/cheaper classifier, set
`model: "claude-haiku-4-5"` and `effort: null` (Haiku does not accept the
effort parameter).

## Which site to test first

Test on **chatgpt.com** first. It works without special selectors for logged-in
state, and its composer (`#prompt-textarea`) and send button are the most stable
targets. Then verify on claude.ai.

A quick test script (all from the spec's test cases):

- `thanks` → should send instantly (pre-filter skip, logged).
- `Fix the grammar in this paragraph` → should send after a brief loading card
  (classified "no friction").
- `Write my cover letter for the Analysis Group analyst role` → full friction
  card: question, timer, answer input.
- `Write a quick follow up email to this recruiter` → small black-and-white
  nudge chip; the message sends immediately.
- Press **Escape** on a full friction card → card fades, message sends,
  dismissal is logged.

## Settings

Click the toolbar icon:

- **On/off** toggle.
- **Intensity**: `standard` (default: fires every time both conditions are
  detected) or `gentle` (fires only in the first ten minutes of a browsing
  session on a given site; a session resets after 30 minutes of inactivity).
- **Timer**: 5 to 60 seconds, default 30.
- **View the log**: opens the private local log page (raw log + weekly chart).

Everything is stored in local browser storage. Nothing is sent anywhere except
the classification calls to the Anthropic API.

---

## Research grounding

- **The timed interruption** comes from Buçinca, Malaya, and Gajos (2021),
  *To Trust or to Think: Cognitive Forcing Functions Can Reduce Overreliance on
  AI in AI-assisted Decision-making*, ACM CSCW1 ([arXiv 2102.09692](https://arxiv.org/abs/2102.09692)),
  the paper that introduced cognitive forcing functions. Their "wait" condition
  told participants the AI was processing for exactly 30 seconds before showing
  its suggestion, and this reduced overreliance. That is why the default timer
  here is 30 seconds.
- **The question categories** (risk, bias, limitation, alternative) come from
  Cai, Arawjo, Sarkar, and collaborators, *"It makes you think": Provocations
  Help Restore Critical Thinking to AI-Assisted Knowledge Work*
  ([arXiv 2501.17247](https://arxiv.org/abs/2501.17247)). Their provocations
  worked by highlighting risks, biases, limitations, or alternatives.
- **The causal evidence for why this matters** comes from Liu, Christian,
  Dumbalska, Bakker, and Dubey (2026) ([arXiv 2604.04721](https://arxiv.org/abs/2604.04721)),
  a randomized controlled trial showing AI assistance reduces persistence and
  independent performance within about ten to fifteen minutes.

## What lives where

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest; content script scoped to the two sites only |
| `config.js` | Your API key + model config (local only) |
| `background.js` | Service worker: classifier call, genuine-effort check, log writes |
| `content.js` | Interception, friction card, nudge chip, release mechanics |
| `popup.html/js` | Settings |
| `log.html/js` | Private log: raw entries (newest first) + weekly bar chart |
| `LIMITATIONS.md` | What the classifier, effort check, and pre-filter get wrong |

## Known limits before you rely on it

See [LIMITATIONS.md](LIMITATIONS.md), short and worth reading once.
