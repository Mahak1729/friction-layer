// The Friction Layer - local config.
//
// PASTE YOUR ANTHROPIC API KEY between the quotes below.
// This file lives only in this folder on your machine. It is read by the
// extension's background service worker and is never sent anywhere except
// directly to api.anthropic.com.

const FRICTION_CONFIG = {
  apiKey: "",

  // The classifier judges task type, delegation, and prior effort from
  // thread context, then writes the reflective question. This is the
  // harder of the two calls, so it runs on Sonnet.
  classifyModel: "claude-sonnet-5",
  classifyEffort: "low",

  // The genuine-effort check only judges whether a one-sentence answer
  // reads as real thought versus filler. Simpler, so it runs on Haiku.
  // Haiku 4.5 does not support the effort parameter at all, so this must
  // stay null (sending any value here would make the API call fail).
  judgeModel: "claude-haiku-4-5",
  judgeEffort: null,
};
