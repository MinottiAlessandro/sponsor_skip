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

// Actually fetch + instantiate a model (no caching slot). modelId is "model" (the
// built-in bundled weights) or a Hugging Face repo id / URL. onProgress, when given,
// is Transformers.js's progress_callback — used to drive the download progress bar.
async function instantiate(modelId, device, onProgress) {
  const { env, AutoTokenizer, AutoModelForTokenClassification, Tensor } = await import(
    "../vendor/transformers.bundle.mjs"
  );
  const bundled = modelId === BUNDLED;
  env.allowRemoteModels = !bundled; // remote model -> fetch from HF/URL
  env.allowLocalModels = true;
  // The Cache API rejects chrome-extension:// URLs, so don't cache the bundled model
  // (it's already local). Remote models cache (that IS the "download").
  env.useBrowserCache = !bundled;
  env.localModelPath = paths.local; // bundled model id = "model"
  env.backends.onnx.wasm.wasmPaths = paths.wasm;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false; // we ARE the worker — no nested offload
  const pc = onProgress ? { progress_callback: onProgress } : {};
  const tokenizer = await AutoTokenizer.from_pretrained(modelId, pc);
  const model = await AutoModelForTokenClassification.from_pretrained(modelId, { dtype: "q8", device, ...pc });
  return { tokenizer, model, Tensor, device };
}

function load(modelId, device) {
  modelId = modelId || BUNDLED;
  const key = `${modelId}@${device}`;
  if (loaded.key !== key) {
    loaded = {
      key,
      promise: instantiate(modelId, device).catch((err) => {
        loaded = { key: null, promise: null }; // allow a retry / different model or device
        throw err;
      }),
    };
  }
  return loaded.promise;
}

// A catalog model must be a token classifier with exactly our label set, or its
// output is meaningless. Checked once at download time.
function validateLabels(model) {
  const id2label = model?.config?.id2label || {};
  const labels = new Set(Object.values(id2label).map((l) => String(l).toLowerCase()));
  for (const need of ["o", "sponsor", "selfpromo", "interaction"]) {
    if (!labels.has(need)) {
      throw new Error(`labels [${[...labels].join(", ")}] don't match the required O / sponsor / selfpromo / interaction`);
    }
  }
}

// Drop every cached file belonging to a repo (free space / clear a bad download),
// and forget it if it's the in-memory model.
async function deleteRepoFromCache(repo) {
  if (typeof caches !== "undefined") {
    const cache = await caches.open("transformers-cache");
    const keys = await cache.keys();
    await Promise.all(keys.filter((req) => req.url.includes(repo)).map((req) => cache.delete(req)));
  }
  if (loaded.key && loaded.key.startsWith(`${repo}@`)) loaded = { key: null, promise: null };
}

// Integrity check: hash the just-downloaded weights (read back from the cache, so no
// re-download) and compare to the sha256 the catalog pinned. A mismatch means a
// corrupted or tampered file — reject it. If the file can't be located to hash (an
// unexpected cache layout, not an attack), warn and proceed rather than block.
async function verifyModelHash(repo, expected) {
  if (!expected || typeof caches === "undefined") return;
  const cache = await caches.open("transformers-cache");
  const keys = await cache.keys();
  const req = keys.find((r) => r.url.includes(repo) && /\.onnx(\?|$)/.test(r.url));
  if (!req) { console.warn("[sponsor_skip:worker] no cached weights to hash-verify for", repo); return; }
  const buf = await (await cache.match(req)).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`integrity check failed — sha256 ${hex.slice(0, 12)}… ≠ expected ${String(expected).slice(0, 12)}…`);
  }
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

  // Download (warm the cache) + validate a model, reporting aggregate progress. Done
  // on CPU (wasm) so a WebGPU quirk can't block a download; detection picks the device.
  if (msg.type === "prepareModel") {
    (async () => {
      try {
        const seen = new Map(); // file -> { loaded, total }
        const onProgress = (p) => {
          if (p && p.status === "progress" && p.total) {
            seen.set(p.file, { loaded: p.loaded || 0, total: p.total });
            let l = 0, t = 0;
            for (const v of seen.values()) { l += v.loaded; t += v.total; }
            self.postMessage({ type: "progress", id: msg.id, pct: t ? Math.round((l / t) * 100) : 0, file: p.file });
          }
        };
        const { model } = await instantiate(msg.model, "wasm", onProgress);
        validateLabels(model);
        await verifyModelHash(msg.model, msg.sha256);
        self.postMessage({ id: msg.id, ok: true });
      } catch (err) {
        // A bad/incompatible/corrupt/tampered download must not linger in the cache.
        try { await deleteRepoFromCache(msg.model); } catch {}
        self.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) });
      }
    })();
    return;
  }

  // Evict a downloaded model's files from the Transformers.js cache (free space).
  if (msg.type === "deleteModelCache") {
    (async () => {
      try {
        await deleteRepoFromCache(msg.repo);
        self.postMessage({ id: msg.id, ok: true });
      } catch (err) {
        self.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) });
      }
    })();
    return;
  }

  if (msg.type === "detect") {
    const run = async (modelId, device) => {
      const { tokenizer, model, Tensor } = await load(modelId, device);
      const t0 = performance.now(); // inference only — the model load above is one-time
      const segments = await detectLocal(msg.cues, { tokenizer, model, Tensor }, msg.opts || {});
      return { segments, ms: Math.round(performance.now() - t0) };
    };
    // Resilience: try the chosen model, then the background's ordered fallbacks (other
    // downloaded models / the built-in default). A model whose weights were evicted or
    // removed fails to load, so we move to the next instead of dead-ending detection.
    const candidates = msg.models?.length ? msg.models : [msg.model];
    let lastErr;
    for (let i = 0; i < candidates.length; i++) {
      const modelId = candidates[i];
      try {
        let device = chooseDevice(msg.device);
        let out;
        try {
          out = await run(modelId, device);
        } catch (err) {
          // Any WebGPU failure (load OR inference — e.g. an op the int8 model needs
          // isn't supported) downgrades to CPU for this and future requests.
          if (device === "webgpu") {
            webgpuBroken = true;
            device = "wasm";
            out = await run(modelId, "wasm");
          } else throw err;
        }
        self.postMessage({ id: msg.id, ok: true, segments: out.segments, device, ms: out.ms, model: modelId, fellBack: i > 0 });
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`[sponsor_skip:worker] model "${modelId}" unavailable, trying next`, err);
      }
    }
    self.postMessage({ id: msg.id, ok: false, error: `no usable model (${String(lastErr?.message || lastErr)})` });
    return;
  }
};
