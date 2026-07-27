# What this gets wrong right now

A short, honest note on the limits of each component, so you know them before
you rely on it.

## The classifier

- **It only sees what's visibly on the page.** Context is the last 10 messages
  scraped from the DOM. Collapsed messages, images, attached files, and content
  in artifacts/canvases are invisible to it, so "prior effort" that lives in an
  attachment or an earlier collapsed message won't count.
- **The ambiguous middle is genuinely fuzzy.** "Draft a LinkedIn message" is
  specced as a nudge, but a similar-shaped ask with higher stakes ("draft my
  reply to this offer negotiation") may also land in nudge territory when it
  arguably deserves full friction. Expect some boundary misses both ways.
- **Hint-style phrasing can hide a full handoff.** "What would a strong final
  paragraph look like for this cover letter" reads like a hint but often
  functions as delegation. The classifier will usually let it through.
- **Thread memory is heuristic.** The "you already answered a friction question
  here" easing is keyed to the tab's URL path and a 20-minute window. Open the
  same thread in a new tab and it forgets; switch threads on a URL that doesn't
  change and it may wrongly remember.
- **The scraped conversation is untrusted input.** In principle, text inside
  the thread (e.g. pasted content) could steer the classifier's judgment.
  It is a mild prompt-injection surface. For a personal tool this is low-risk,
  but it exists.
- **It costs a round trip.** Every message of 3+ words waits on an API call
  before sending. If the API is slow, you feel it; if it fails, the extension
  fails open and that turn gets no friction at all.

## The genuine-effort check

- **It's gameable by anyone who writes one plausible sentence.** It rejects
  filler and restatement, but "I think leading with KTRS is right because it's
  more analytical" passes whether or not you actually believe it. It measures
  the shape of thought, not thought.
- **It can false-reject terse honesty.** A genuinely considered but very short
  answer ("risk: it'll sound generic") sometimes reads as filler. Two
  rejections still let you through, so the cost is bounded at one retry.
- **It fails open.** If the check call errors, your answer is accepted as-is.

## The pre-filter

- **Word count is a crude proxy.** "do that" and "write it" are both under 3
  words and skip the API entirely, but in a thread where the assistant just
  proposed writing your essay, "write it" *is* a full handoff. The pre-filter
  lets it through unexamined.
- Conversely, 3-word mechanical messages ("fix grammar please") always burn an
  API call even though they'll classify as no-friction.

## The plumbing (worth knowing)

- **Selectors are pinned to today's DOM.** chatgpt.com (`#prompt-textarea`,
  `#composer-submit-button` / `data-testid="send-button"`) and claude.ai
  (ProseMirror editor, `aria-label` containing "Send") redesign their UIs
  regularly. When a selector breaks, interception silently stops working, and
  messages just send normally. If friction stops appearing, suspect this first.
- **Only Enter and the send button are intercepted.** Voice input, "regenerate",
  and edits to earlier messages are not.
- The claude.ai send button is found by its English `aria-label`; a non-English
  UI language will break interception there.
