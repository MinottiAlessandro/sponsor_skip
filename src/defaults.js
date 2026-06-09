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
  language: "auto", // UI language: "auto" follows the browser; or "en"/"it"/"es"/"fr"/"de"
  useSponsorBlock: true,
  detector: "local", // "local" = on-device model; "ollama" = local LLM (dev)
  device: "wasm", // on-device model runtime: "wasm" (CPU) | "webgpu" (GPU, experimental)
  modelId: "default", // which catalog model is active (see src/models/catalog.json)
  customModel: "", // advanced override: an arbitrary HF repo id/URL (wins over modelId)
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
    // Manual segments are user-authored (they picked the spot AND the reason), so
    // they always apply regardless of the per-category skip toggles; the toggles
    // govern only the automatic sources (the model + the SponsorBlock database).
    .filter((s) => s.manual || settings.categories[s.category] !== false)
    .filter((s) => (s.confidence ?? 1) >= settings.minConfidence)
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
}
