<p align="center">
  <img src="icons/icon128.png" width="96" alt="sponsor_skip logo" />
</p>

<h1 align="center">sponsor_skip</h1>

<p align="center">
  <b>Automatically skip in-video, creator-read sponsorships on YouTube — fully on your device.</b><br/>
  <sub>Not YouTube's own ads — the "this video is sponsored by…" reads baked into the video.</sub>
</p>

<p align="center">
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
API keys — the transcript and everything else **never leave your device**.

- 🎯 **Detects creator-read sponsorships** (and optionally self-promo & like/subscribe begs), including the lead-in "but first…" segue.
- 🟡 **Marks them in yellow** on the progress bar, SponsorBlock-style.
- ⏭️ **Auto-skips** (with an optional cancelable countdown) or shows a **Skip** button — your choice.
- 🌍 **Multilingual** — English, Italian, Spanish, French, German.
- 🔒 **100% private** — on-device detection; nothing is uploaded.
- ⚡ **Instant on known videos** via the community SponsorBlock database (queried privately).

## Privacy first

This is the whole point. Detection uses a bundled neural model executed locally
through WebAssembly. The only network requests sponsor_skip makes are:

| Request | Why | Private? |
|---|---|---|
| YouTube captions | to read the transcript it analyzes | same requests the player already makes |
| SponsorBlock (optional) | instant skips on already-labeled videos | queried by a **hash prefix** of the video ID, so the service never learns which video you're watching |

No telemetry. No analytics. No sponsor data sent anywhere.

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

- **Status** — pick how to act on sponsors (**Auto-skip · Button · Off**), see the segments found in the current video (click one to jump to it), and any error.
- **Skipping** — countdown length & style, which categories to skip (sponsor / self-promo / interaction), confidence, and where the status indicator shows.
- **Detector** — SponsorBlock toggle, the detection backend, **Reset sponsor cache**, and **Test the model**.
- **Look** — light / dark / auto theme.

While a video is analyzed, a small pill appears top-left of the player; when it's
done you'll see the sponsor sections highlighted **yellow** on the progress bar. In
auto mode it jumps past them (you can cancel any single skip).

> 💡 If a video fails to analyze, the toolbar icon shows a red **!** — open the popup to read why.

## Languages

Trained on native YouTube transcripts in **English, Italian, Spanish, French, and
German**. Detection quality is strongest in ES/IT/EN; German is the weakest of the
five but still works. Other languages may partially work thanks to the multilingual
base model, but aren't officially supported.

## How it works

1. sponsor_skip reads the video's caption track (the same one YouTube's player uses).
2. For videos the SponsorBlock community has already labeled, it uses those
   human-verified segments instantly (queried privately).
3. Otherwise it runs a fine-tuned multilingual **token-classification model**
   (distilBERT-based) over the transcript via **Transformers.js / ONNX Runtime Web**,
   tags sponsor/self-promo/interaction cues, groups them into segments, and skips.

A confidence-biased decoder keeps it on the safe side — it would rather start a skip
a second late than cut into real content.

## Advanced

All in the **Detector** tab:

- **Custom model** — point sponsor_skip at your own Transformers.js-compatible ONNX
  token-classifier (a Hugging Face repo id like `you/your-model`, or a URL). Labels
  must be `O, sponsor, selfpromo, interaction`.
- **Local LLM (Ollama)** — for development, switch detection to a local LLM. Run
  `OLLAMA_ORIGINS=* ollama serve` so the extension can reach it.
- **Reset sponsor cache** — clears cached results so videos are re-analyzed.

## Limitations

- Needs a caption/transcript to work; videos with captions disabled can't be analyzed.
- YouTube rate-limits caption downloads — heavy use can briefly fail (the icon shows it); it recovers on its own.
- It targets **creator-read sponsorships**, not YouTube's own ad breaks.
- Boundaries are caption-granular (a second or two), and it's tuned for precision, so it occasionally misses a softer sponsor read rather than risk over-skipping.

## Development

The extension is plain MV3 + JavaScript — no build step to load it. The on-device
model is the only piece not in git (too large): it lives under `model/onnx/` and is
produced by a separate training pipeline. The Transformers.js runtime in `vendor/`
is bundled with esbuild.

```
src/        content script, background worker, offscreen model host, detector
popup/      the tabbed UI
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
