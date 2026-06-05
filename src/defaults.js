// Single source of truth for the user-facing settings defaults and the segment
// filter. Loaded as a plain (non-module) script so its top-level declarations are
// shared with the script that runs after it: the content script (manifest lists
// this first) and the popup (popup.html includes it before popup.js). The
// background service worker keeps its own detection-tuning constants separately.

const DEFAULTS = {
  mode: "button", // "auto" | "button" | "off"
  minConfidence: 0.6,
  autoSkipDelay: 3, // seconds of "Auto-skip in Xs" countdown before the jump
  countdownMode: "grace", // "grace" plays the start; "preroll" skips from the very start
  statusIndicator: "both", // "both" | "page" | "badge" | "off"
  theme: "auto",
  useSponsorBlock: true,
  detector: "local", // "local" = bundled on-device model; "ollama" = local LLM (dev)
  customModel: "",
  categories: { sponsor: true, selfpromo: true, interaction: false },
  endpoint: "http://localhost:11434/api/generate",
  model: "gemma4:latest",
  maxSegmentSeconds: 300,
};

// Apply the user's category/confidence settings to raw detected segments. Shared
// by the content script (timeline markers) and the popup (status list) so the two
// always show exactly the same set.
function filterSegments(segments, settings) {
  return (segments || [])
    .filter((s) => settings.categories[s.category] !== false)
    .filter((s) => (s.confidence ?? 1) >= settings.minConfidence)
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
}
