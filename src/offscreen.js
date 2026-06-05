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

// Keyed by model id so switching the model (advanced setting) reloads. The
// bundled model is id "model" (loaded from the extension); any other id is treated
// as a remote/HuggingFace model (must be a Transformers.js-compatible ONNX repo).
const BUNDLED = "model";
let loaded = { id: null, promise: null };
function load(modelId) {
  modelId = modelId || BUNDLED;
  if (loaded.id !== modelId) {
    loaded = {
      id: modelId,
      promise: (async () => {
        console.log(`[ad_skip:offscreen] importing transformers.js… (model: ${modelId})`);
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
        env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false;
        console.log("[ad_skip:offscreen] loading tokenizer…");
        const tokenizer = await AutoTokenizer.from_pretrained(modelId);
        console.log("[ad_skip:offscreen] tokenizer ok; loading model (wasm/q8)…");
        const model = await AutoModelForTokenClassification.from_pretrained(modelId, {
          dtype: "q8",
          device: "wasm",
        });
        console.log("[ad_skip:offscreen] model ready");
        return { tokenizer, model, Tensor };
      })().catch((err) => {
        loaded = { id: null, promise: null }; // allow a retry / different model
        throw err;
      }),
    };
  }
  return loaded.promise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen-adskip") return;
  if (msg.type === "localDetect") {
    (async () => {
      try {
        const { tokenizer, model, Tensor } = await load(msg.model);
        console.log(`[ad_skip:offscreen] detecting over ${msg.cues?.length || 0} cues…`);
        const segments = await detectLocal(msg.cues, { tokenizer, model, Tensor }, msg.opts || {});
        console.log(`[ad_skip:offscreen] done: ${segments.length} segment(s)`);
        sendResponse({ ok: true, segments });
      } catch (err) {
        console.error("[ad_skip:offscreen] detect failed", err);
        sendResponse({ ok: false, error: String(err?.stack || err) });
      }
    })();
    return true; // async response
  }
});
