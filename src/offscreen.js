// Offscreen detector: loads the fine-tuned token classifier via Transformers.js
// (ONNX Runtime Web, all offline/bundled) and runs sliding-window detection over
// the transcript cues. Lives in an offscreen document because a service worker
// can't keep a 129 MB model resident across its short lifecycle.
//
// IMPORTANT: the message listener is registered synchronously and Transformers.js
// is pulled in via a *dynamic* import inside load(). If a static top-level import
// throws, the whole module dies before addListener runs and the background just
// sees "Receiving end does not exist" with no clue why. This way the listener
// always exists and any load failure is reported back as a real error.

import { detectLocal } from "./local_detector.js"; // no deps; safe to import statically

console.log("[ad_skip:offscreen] script loaded");

// Keyed by model id + device so switching either (advanced settings) reloads. The
// bundled model is id "model" (loaded from the extension); any other id is treated
// as a remote/HuggingFace model (must be a Transformers.js-compatible ONNX repo).
const BUNDLED = "model";
let loaded = { key: null, promise: null };
// Once WebGPU fails to bring up the model, stop trying it for the rest of this
// offscreen session and stay on CPU (reload the extension to retry).
let webgpuBroken = false;

function load(modelId, device) {
  modelId = modelId || BUNDLED;
  const key = `${modelId}@${device}`;
  if (loaded.key !== key) {
    loaded = {
      key,
      promise: (async () => {
        console.log(`[ad_skip:offscreen] importing transformers.js… (model: ${modelId}, device: ${device})`);
        const { env, AutoTokenizer, AutoModelForTokenClassification, Tensor } = await import(
          "../vendor/transformers.bundle.mjs"
        );
        const bundled = modelId === BUNDLED;
        env.allowRemoteModels = !bundled; // custom model -> fetch from HF/URL
        env.allowLocalModels = true;
        // The Cache API rejects chrome-extension:// URLs, so don't try to cache the
        // bundled model (it's already local). Remote custom models can still cache.
        env.useBrowserCache = !bundled;
        env.localModelPath = chrome.runtime.getURL(""); // bundled model id = "model"
        // WebGPU still loads its kernels from the JSEP wasm in vendor/, so wasmPaths
        // matters for both devices.
        env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        console.log("[ad_skip:offscreen] loading tokenizer…");
        const tokenizer = await AutoTokenizer.from_pretrained(modelId);
        console.log(`[ad_skip:offscreen] tokenizer ok; loading model (${device}/q8)…`);
        const model = await AutoModelForTokenClassification.from_pretrained(modelId, {
          dtype: "q8",
          device,
        });
        console.log(`[ad_skip:offscreen] model ready (device: ${device})`);
        return { tokenizer, model, Tensor, device };
      })().catch((err) => {
        loaded = { key: null, promise: null }; // allow a retry / different model or device
        throw err;
      }),
    };
  }
  return loaded.promise;
}

// Honor "webgpu" only when the browser exposes WebGPU and it hasn't already failed
// this session; otherwise CPU (wasm). The model load is the final validation — if
// WebGPU can't actually run the model, the caller catches it and retries on CPU.
function chooseDevice(requested) {
  if (requested === "webgpu" && !webgpuBroken && typeof navigator !== "undefined" && navigator.gpu) {
    return "webgpu";
  }
  return "wasm";
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen-adskip") return;
  if (msg.type === "localDetect") {
    (async () => {
      const run = async (device) => {
        const { tokenizer, model, Tensor } = await load(msg.model, device);
        console.log(`[ad_skip:offscreen] detecting over ${msg.cues?.length || 0} cues (device: ${device})…`);
        const t0 = performance.now(); // inference only — the model load above is one-time
        const segments = await detectLocal(msg.cues, { tokenizer, model, Tensor }, msg.opts || {});
        return { segments, ms: Math.round(performance.now() - t0) };
      };
      try {
        let device = chooseDevice(msg.device);
        let out;
        try {
          out = await run(device);
        } catch (err) {
          // Any WebGPU failure (load OR inference — e.g. an op the int8 model needs
          // isn't supported) downgrades to CPU for this and future requests.
          if (device === "webgpu") {
            console.warn("[ad_skip:offscreen] WebGPU failed — falling back to CPU (wasm)", err);
            webgpuBroken = true;
            device = "wasm";
            out = await run("wasm");
          } else throw err;
        }
        console.log(`[ad_skip:offscreen] done: ${out.segments.length} segment(s) (device: ${device}, ${out.ms}ms)`);
        sendResponse({ ok: true, segments: out.segments, device, ms: out.ms });
      } catch (err) {
        console.error("[ad_skip:offscreen] detect failed", err);
        sendResponse({ ok: false, error: String(err?.stack || err) });
      }
    })();
    return true; // async response
  }
});
