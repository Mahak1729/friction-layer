# What this gets wrong right now

A short, honest list of where each part falls short, so you know before you
rely on it.

## The classifier

- **It only sees what is on the page.** Its context is the last 10 messages
  read from the page. Collapsed messages, images, attached files, and anything
  inside artifacts or canvases are invisible to it, so effort that lives in an
  attachment or an older collapsed message does not count.
- **The middle ground is fuzzy.** "Draft a LinkedIn message" is meant to be a
  nudge, but a similar ask with higher stakes ("draft my reply to this offer
  negotiation") can also land as a nudge when it arguably deserves full
  friction. Expect some misses at the boundary in both directions.
- **A hint can hide a full handoff.** "What would a strong final paragraph look
  like for this cover letter" reads like a request for a hint but often works
  as delegation. The classifier will usually let it through.
- **Thread memory is a rough guess.** Easing off after you already answered a
  question in a thread is tied to the tab's URL path and a 20 minute window.
  Open the same thread in a new tab and it forgets. Switch threads on a URL
  that does not change and it may wrongly remember.
- **The conversation it reads is untrusted.** In principle, text inside the
  thread (pasted content, for example) could steer the classifier. That is a
  mild prompt injection surface. For a personal tool the risk is low, but it
  is there.
- **It adds a round trip.** Every message of three words or more waits on an
  API call before it sends. If the API is slow, you feel it. If it fails, the
  extension fails open and that message gets no friction at all.

## The effort check

- **One plausible sentence beats it.** It rejects filler and restated prompts,
  but "I think leading with the analytical project is right because it shows
  more rigor" passes whether or not you believe it. It measures the shape of
  thought, not thought itself.
- **It can turn back short, honest answers.** A considered but very terse
  answer ("risk, it will sound generic") sometimes reads as filler. Two
  rejections still let you through, so the cost is one retry at most.
- **It fails open.** If the check errors, your answer is accepted as is.

## The pre-filter

- **Word count is a blunt tool.** "do that" and "write it" are under three
  words and skip the API, but in a thread where the AI just offered to write
  your essay, "write it" *is* a full handoff. The pre-filter lets it through
  unchecked.
- On the other side, three word mechanical messages ("fix grammar please")
  always cost an API call even though they will come back as no friction.

## The plumbing

- **Selectors are tied to how each site looks today.** Both sites redesign
  often, and when a selector breaks, interception stops quietly and messages
  just send. This already happened once. In November 2026 ChatGPT dropped its
  `#prompt-textarea` box for an editor with no id, and the ChatGPT adapter had
  to be updated. If the card stops showing up, check this first.
  - chatgpt.com: the ProseMirror editor labeled "Ask ChatGPT" and the form's
    **Send** button, with the older `#prompt-textarea` and
    `#composer-submit-button` kept as fallbacks
  - claude.ai: the ProseMirror editor and the button labeled "Send message"
- **Only Enter and the send button are caught.** Voice input, regenerate, and
  edits to earlier messages are not.
- **Send buttons are matched by English labels.** On both sites the send
  button is found by its English `aria-label`, so a different interface
  language can break clicking send. Pressing Enter in the message box should
  still be caught.
