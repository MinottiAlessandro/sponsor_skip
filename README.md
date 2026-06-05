<p align="center">
  <img src="icons/icon128.png" width="96" alt="sponsor_skip logo" />
</p>

<h1 align="center">sponsor_skip</h1>

<p align="center">
  <b>Automatically skip in-video, creator-read sponsorships on YouTube — fully on your device.</b><br/>
  <sub>Not YouTube's own ads — the "this video is sponsored by…" reads baked into the video.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.6.0-f0a500" alt="Version 0.6.0" />
  <img src="https://img.shields.io/badge/Manifest-V3-3367d6" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/detection-100%25%20on--device-2ea44f" alt="On-device" />
  <img src="https://img.shields.io/badge/privacy-no%20servers-2ea44f" alt="Private" />
  <img src="https://img.shields.io/badge/languages-EN%20·%20IT%20·%20ES%20·%20FR%20·%20DE-f0a500" alt="Languages" />
</p>

<p align="center">
  <a href="https://ko-fi.com/alessandromino">
    <img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi" />
  </a>
</p>

---

## What it does

Creators get paid to read out sponsor spots mid-video ("today's video is brought to
you by…"). **sponsor_skip** finds those segments from the video's captions and skips them
for you — automatically, or with a one-click button.

It runs a small AI model **entirely in your browser**. No account, no servers, no
API keys — the transcript and the detection **never leave your device**.

- 🎯 **Detects creator-read sponsorships** (and optionally self-promo & like/subscribe begs), including the lead-in "but first…" segue.
- 🟡 **Marks them in yellow** on the progress bar, SponsorBlock-style.
- ✋ **Fine-tune on the fly** — drag the marker edges to fix a start/end, or add a sponsor segment by hand.
- ⏭️ **Auto-skips** (with an optional cancelable countdown) or shows a **Skip** button — your choice.
- 🔀 **Swappable models** — pick the on-device model from a curated list and download better ones over time.
- 🤝 **Give back (optional)** — vote on SponsorBlock segments, or contribute the ones your model found.
- 🌍 **Multilingual** — English, Italian, Spanish, French, German.
- 🔒 **Private by default** — detection is on-device; nothing is sent anywhere unless you choose to contribute.
- ⚡ **Instant on known videos** via the community SponsorBlock database (queried privately).

## Privacy first

This is the whole point. **Detection runs entirely on your device** — the transcript
and the neural-network inference never leave your browser. There's no telemetry, no
analytics, and nothing is sent anywhere automatically beyond the requests below.

| Request | When | Why | Private? |
|---|---|---|---|
| **YouTube captions** | every analyzed video | to read the transcript it analyzes | the same requests the player already makes |
| **SponsorBlock lookup** *(optional, on by default)* | per video | instant skips on already-labeled videos | queried by a **hash prefix** of the video ID, so the service never learns which video you're watching |
| **SponsorBlock contribution** *(optional, only when you click)* | when you vote or submit a segment | to share a vote / a sponsor segment with the community DB | sends only that segment plus a **random local ID** (not linked to you or your Google account) |
| **Hugging Face** *(optional)* | only when you refresh the model list or download a model | to fetch the model catalog and the model weights you pick | plain file downloads, no account, no tracking |

Nothing is uploaded unless **you** initiate it (a vote, a segment submission, or a
model download). Detection results are cached locally only.

## Install

> sponsor_skip isn't on the Chrome Web Store yet — install it unpacked (Chrome, Edge, Brave, or any Chromium browser).

**Recommended (ready to run):**

1. Download the latest **[Release](../../releases)** `.zip` (it includes the model) and unzip it.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder.
5. Open any YouTube video — that's it.

<sub>Cloning the repo instead? The ~129 MB model file isn't stored in git — grab it from the Release, or see [Development](#development).</sub>

## Using it

Click the toolbar icon to open the popup. It has four tabs:

- **Status** — pick how to act on sponsors (**Auto-skip · Button · Off**), see the segments found in the current video (and *how* — SponsorBlock or the on-device model, with the backend and analysis time), click a segment to jump to it, **vote / contribute** with the 👍 / 👎 buttons, **add a segment by hand**, and read any error.
- **Skipping** — countdown length & style, which categories to skip (sponsor / self-promo / interaction), minimum confidence, and where the status indicator shows.
- **Detector** — SponsorBlock toggle, the **model manager** (pick / download / delete on-device models), **CPU or GPU**, max segment length, **Reset sponsor cache**, **Test the model**, and advanced overrides.
- **Look** — light / dark / auto theme.

While a video is analyzed, a small pill appears top-left of the player; when it's
done you'll see the sponsor sections highlighted **yellow** on the progress bar. In
auto mode it jumps past them (you can cancel any single skip).

> 💡 If a video fails to analyze, the toolbar icon shows a red **!** — open the popup to read why.

### Fine-tuning & adding segments

The model is tuned for precision, so it occasionally clips a boundary or misses a
softer read. You can fix that right on the player:

- **Drag the yellow marker edges** on the progress bar to adjust a sponsor's start or
  end — you get a live frame preview as you drag, and your watch position is restored
  on release.
- **"+ Add a sponsor segment here"** (Status tab) drops a segment at the current
  playhead; drag its edges to fit. Handy on videos where nothing was detected.

Your edits are saved per video and used for skipping immediately.

### Contributing back to SponsorBlock (optional)

Every segment in the list has 👍 / 👎 buttons, with meaning depending on where it came
from:

- **A SponsorBlock segment** → up/down **vote** on it.
- **A segment your model found** → 👍 opens a confirm to **submit it to SponsorBlock**
  (please fix the boundaries first), so everyone benefits; 👎 dismisses it locally as a
  false positive.

It's entirely opt-in. A private, locally-generated ID identifies you to SponsorBlock
for voting/submitting — it's never shown and isn't tied to your Google account.

### Choosing a model

The **Detector** tab lists the available on-device models from a curated Hugging Face
catalog. The **default is built in** and works offline with no download. You can:

- **Download** an alternative or an improved model (with a progress bar),
- **Use** any downloaded model as the active one,
- **Delete** downloads to reclaim space, and
- **Refresh** to pull the latest catalog.

Downloads are **verified by SHA-256**, and if your active model ever goes missing
(e.g. the browser evicts it), detection automatically falls back to another available
model and tells you.

## How it works

1. sponsor_skip reads the video's caption track (the same one YouTube's player uses).
2. For videos the SponsorBlock community has already labeled, it uses those
   human-verified segments instantly (queried privately).
3. Otherwise it runs a fine-tuned multilingual **token-classification model**
   (distilBERT-based) over the transcript via **Transformers.js / ONNX Runtime Web**,
   on a background **Web Worker** (so the UI stays responsive), tags
   sponsor/self-promo/interaction cues, groups them into segments, and skips.

A confidence-biased decoder keeps it on the safe side — it would rather start a skip
a second late than cut into real content.

## Advanced

All in the **Detector** tab:

- **Model manager** — switch between on-device models, download new ones from the
  Hugging Face catalog, or delete them to free space (see [Choosing a model](#choosing-a-model)).
- **Custom model** *(override)* — point sponsor_skip at any Transformers.js-compatible
  ONNX token-classifier (a Hugging Face repo id like `you/your-model`, or a URL). Labels
  must be `O, sponsor, selfpromo, interaction`.
- **Run on CPU or GPU** — CPU (WebAssembly) is the default and works everywhere; GPU
  (WebGPU) can be faster on some machines and falls back to CPU automatically.
- **Local LLM (Ollama)** — for development, switch detection to a local LLM. Run
  `OLLAMA_ORIGINS=* ollama serve` so the extension can reach it.
- **Reset sponsor cache** — clears cached results so videos are re-analyzed.

## Limitations

- Needs a caption/transcript to work; videos with captions disabled can't be analyzed.
- YouTube rate-limits caption downloads — heavy use can briefly fail (the icon shows it); it recovers on its own.
- It targets **creator-read sponsorships**, not YouTube's own ad breaks.
- Auto-detected boundaries are caption-granular (a second or two) and tuned for precision, so it occasionally misses a softer read rather than over-skip — you can always drag a boundary or add a segment by hand to fix it.

## Development

The extension is plain MV3 + JavaScript — no build step to load it. The on-device
model is the only piece not in git (too large): it lives under `model/onnx/` and is
produced by a separate training pipeline. The Transformers.js runtime in `vendor/`
is bundled with esbuild.

```
src/        content script, background worker, offscreen model host,
            detector.worker.js (model runs here, off the main thread)
popup/      the tabbed UI
models/     bundled model catalog (offline fallback for the HF catalog)
model/      tokenizer + config (+ onnx weights, provided via Release)
vendor/     Transformers.js + ONNX Runtime WASM
icons/      app icons
```

PRs and issues welcome.

## Credits

Built on the shoulders of [SponsorBlock](https://sponsor.ajay.app/),
[🤗 Transformers.js](https://github.com/huggingface/transformers.js), and
[ONNX Runtime Web](https://onnxruntime.ai/). Sponsor labels for training come from
the SponsorBlock community database.

## Support

If sponsor_skip saves you time, you can buy me a coffee — it genuinely helps and is hugely
appreciated. ☕

<p>
  <a href="https://ko-fi.com/alessandromino">
    <img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi" />
  </a>
</p>

## License

Released under the **MIT License**.
