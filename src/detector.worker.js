// Detector Web Worker — hosts the Transformers.js model and runs inference on its
// OWN thread, off the shared extension main thread.
//
// Why this exists: all of an extension's same-origin pages (popup + offscreen
// document) share a single renderer process and event loop. ONNX Runtime Web's
// WASM inference is a *synchronous* CPU computation — each model() call blocks that
// shared thread for its whole duration, which made the popup laggy (and sometimes
// un-openable) while a video was being analyzed. ORT's built-in worker offload
// (env.wasm.proxy = true) spawns a blob: worker, which MV3's CSP (script-src 'self')
// forbids — so instead the offscreen document hosts THIS extension-packaged module
// worker (allowed, since it's same-origin 'self') and relays detect requests to it.
//
// chrome.* APIs aren't available inside a dedicated worker, so the host page sends
// the base URLs it resolves with chrome.runtime.getURL() in an "init" message.

import { detectLocal } from "./local_detector.js"; // no deps; safe to import statically

const BUNDLED = "model";
let paths = null; // { local, wasm } — set by the host's init message before any detect
let loaded = { key: null, promise: null };
// Once WebGPU fails to bring up the model, stop trying it for the rest of this
// worker's life and stay on CPU (reload the extension to retry).
let webgpuBroken = false;

function load(modelId, device) {
  modelId = modelId || BUNDLED;
  const key = `${modelId}@${device}`;
  if (loaded.key !== key) {
    loaded = {
      key,
      promise: (async () => {
        const { env, AutoTokenizer, AutoModelForTokenClassification, Tensor } = await import(
          "../vendor/transformers.bundle.mjs"
        );
        const bundled = modelId === BUNDLED;
        env.allowRemoteModels = !bundled; // custom model -> fetch from HF/URL
        env.allowLocalModels = true;
        // The Cache API rejects chrome-extension:// URLs, so don't cache the bundled
        // model (it's already local). Remote custom models can still cache.
        env.useBrowserCache = !bundled;
        env.localModelPath = paths.local; // bundled model id = "model"
        env.backends.onnx.wasm.wasmPaths = paths.wasm;
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.proxy = false; // we ARE the worker — no nested offload
        const tokenizer = await AutoTokenizer.from_pretrained(modelId);
        const model = await AutoModelForTokenClassification.from_pretrained(modelId, {
          dtype: "q8",
          device,
        });
        return { tokenizer, model, Tensor, device };
      })().catch((err) => {
        loaded = { key: null, promise: null }; // allow a retry / different model or device
        throw err;
      }),
    };
  }
  return loaded.promise;
}

// Honor "webgpu" only when this worker exposes WebGPU and it hasn't already failed;
// otherwise CPU (wasm). The model load is the final validation — if WebGPU can't
// actually run the model, the caller catches it and retries on CPU.
function chooseDevice(requested) {
  if (requested === "webgpu" && !webgpuBroken && typeof navigator !== "undefined" && navigator.gpu) {
    return "webgpu";
  }
  return "wasm";
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === "init") {
    paths = msg.paths; // { local, wasm }
    return; // fire-and-forget; ordered delivery guarantees this lands before detect
  }

  if (msg.type === "detect") {
    const run = async (device) => {
      const { tokenizer, model, Tensor } = await load(msg.model, device);
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
          webgpuBroken = true;
          device = "wasm";
          out = await run("wasm");
        } else throw err;
      }
      self.postMessage({ id: msg.id, ok: true, segments: out.segments, device, ms: out.ms });
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: String(err?.stack || err) });
    }
  }
};
