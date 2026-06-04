# ad_skip — browser extension

Detects and skips **in-video creator-read sponsor segments** on YouTube using a
**bundled on-device model** — a fine-tuned multilingual token classifier that runs
entirely in your browser via Transformers.js (ONNX Runtime Web). No server, no
account, nothing to install. A local-LLM (Ollama) backend is also available for
development. The detector is a swappable module.

## How it works

1. `inject.js` (page MAIN world) reads the YouTube player response → caption tracks.
2. `content.js` fetches the transcript (`timedtext` JSON), then asks the background
   worker for sponsor segments and runs the skip UI.
3. `background.js` checks the SponsorBlock fast-path, then runs the on-device model
   in an **offscreen document** (`offscreen.js` + `local_detector.js`): a sliding
   window over the cues → per-token sponsor probability → per-cue vote → contiguous
   sponsor cues become segments (gap-merged, over-skip-guarded). Cached per video.
4. Skip: **auto-skip**, **"Skip ▶" button**, or **off** (toggle in the popup).

## UX features

All settings live in the **toolbar popup**, organized into tabs — **Status**
(mode + detected segments + errors), **Skipping**, **Detector**, **Look**. It
auto-saves; there's no separate options page.

- **Status indicator** (no click needed): an on-player pill (top-left, auto-shifts
  below YouTube's "Includes paid promotion" overlay) shows a spinner while working,
  then "✓ N sponsors found", or a red "!" on failure. The toolbar icon also shows a
  per-tab badge: "…" working → count when done (green/grey), "!" on error — click the
  icon to open the popup and expand the reason. Configurable in **Skipping**:
  Both / On-page only / Badge only / Off.
- **Yellow progress-bar markers** over sponsor sections, re-applied live via a
  MutationObserver so they survive YouTube rebuilding the bar (no reload needed).
- **Auto-skip countdown**: "Auto-skip in Xs" (length in **Skipping**, default 3s;
  0 = instant) with click-to-cancel. *grace* counts down inside the ad, *pre-roll*
  skips from the very start.
- **Popup → Status**: lists the current video's sponsors with timestamps + how they
  were found ("via …"); click a segment to jump. Quick Auto/Button/Off pills.
- **Theme** (**Look** tab): Auto / Light / Dark (shared `theme.js`).
- **Custom model** (**Detector** tab, advanced): swap the bundled on-device model for
  any Transformers.js ONNX model (HF repo id or URL), or switch to the Ollama LLM.

## Setup

1. Chrome → `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Open a YouTube video. That's it — the model is bundled and runs on-device.

The on-device model files live under `model/` (INT8 ONNX, ~135 MB) and the
Transformers.js runtime + ONNX WASM under `vendor/` — all loaded locally, no
network. First detection on a fresh session loads the model into the offscreen
document (a second or two); inference is then ~15 ms per window.

### Updating the on-device model

The detector is a fine-tuned multilingual token classifier (EN/IT/ES/FR/DE), trained
on native SponsorBlock-labeled transcripts. To ship a new model:

```bash
# retrain (see spike/train_prod.py + spike/eval_prod.py), then:
spike/install_model.sh spike/model_prod 2026.06.04   # export INT8 ONNX -> extension/model/ + stamp version
```

This rewrites `extension/model/` (config, tokenizer, `onnx/model_quantized.onnx`) and
`model_version.json`. Reload the extension to pick it up; the version shows on the
popup's **Detector** tab. The Transformers.js runtime (`vendor/transformers.bundle.mjs`)
is model-agnostic, so it's unchanged. If the label set changes, update `SPONSOR_CLASS`
in `src/local_detector.js`.

### Optional: Ollama backend (development)

Set **Detector → Detection backend → Local LLM via Ollama** in the popup to use a local LLM
instead. Then:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3n:e4b            # the Gemma E4B build you want
OLLAMA_ORIGINS=* ollama serve      # so a chrome-extension:// origin isn't CORS-blocked
```

The extension calls `http://localhost:11434/api/generate` by default (configurable).

## Status / limits

- **SponsorBlock fast-path**: known videos use crowdsourced human-verified segments
  (queried privately by SHA-256 hash-prefix) and skip the model entirely. Toggle in
  options. Unknown videos fall back to the on-device model.
- **On-device model**: fine-tuned `distilbert-base-multilingual-cased` token
  classifier (EN/IT/ES/FR/DE), trained on the SponsorBlock corpus + translation
  augmentation. Held-out span F1 ~72–78% per language, high precision (over-skip-
  averse). Fully private; nothing leaves the browser.
- The model runs in an offscreen document (the service worker can't keep 135 MB
  resident). Long transcripts are processed as a sliding window over cues; total
  lines capped at `maxLines` to bound runtime.
- `detect_test.py` is a CLI harness mirroring the Ollama backend; `spike/` holds the
  training/eval/export pipeline for the on-device model.
- The Ollama dev backend uses free-text output + quote-based extraction (NOT
  `format:"json"`, which collapses small models).
- Results are cached per video after the first view.
- Rapid video-switching is throttled: detection is debounced ~700ms and the
  in-flight transcript fetch + LLM calls for an abandoned video are aborted, so the
  user can't pile up a queue for the model.
