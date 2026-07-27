// The Friction Layer - local config.
//
// PASTE YOUR ANTHROPIC API KEY between the quotes below.
// This file lives only in this folder on your machine. It is read by the
// extension's background service worker and is never sent anywhere except
// directly to api.anthropic.com.

const FRICTION_CONFIG = {
  apiKey: "",

  // Model used for both the classifier and the genuine-effort check.
  model: "claude-opus-5",

  // Reasoning effort. "low" keeps the interruption fast with claude-opus-5.
  // If you switch to a model that does not support the effort parameter
  // (e.g. "claude-haiku-4-5"), set this to null.
  effort: "low",
};
