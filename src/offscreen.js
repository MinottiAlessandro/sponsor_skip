// Offscreen relay: owns the detector Web Worker and forwards detect requests to it.
//
// The model used to load and run inference directly here, but the offscreen
// document shares its renderer thread with the popup, so inference froze the popup
// (laggy / sometimes un-openable) during analysis. The heavy work now lives in
// src/detector.worker.js on its own thread; this document just (1) creates the
// worker, (2) hands it the base URLs it needs (chrome.* isn't available inside a
// worker), and (3) relays background<->worker messages.
//
// The message listener is registered synchronously so the background never sees
// "Receiving end does not exist" for a reason it can't diagnose; any failure is
// reported back as a real error instead.

console.log("[sponsor_skip:offscreen] script loaded");

let worker = null;
let seq = 0;
const pending = new Map(); // request id -> resolver

function failAllPending(error) {
  for (const [, resolve] of pending) resolve({ ok: false, error });
  pending.clear();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL("src/detector.worker.js"), { type: "module" });
  worker.onmessage = (e) => {
    const data = e.data || {};
    // Streaming download progress — relay to the popup/background, don't resolve.
    if (data.type === "progress") {
      chrome.runtime.sendMessage({ type: "downloadProgress", id: data.id, pct: data.pct, file: data.file }).catch(() => {});
      return;
    }
    const { id, ...rest } = data;
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(rest);
    }
  };
  worker.onerror = (e) => {
    console.error("[sponsor_skip:offscreen] worker error", e.message || e);
    // The worker is likely dead — fail in-flight requests and rebuild on next use.
    failAllPending(String(e.message || "detector worker crashed"));
    try {
      worker.terminate();
    } catch {}
    worker = null;
  };
  // chrome.* isn't available inside the worker, so pass it the resolved base URLs.
  // Ordered delivery guarantees this init lands before any detect request.
  worker.postMessage({
    type: "init",
    paths: { local: chrome.runtime.getURL(""), wasm: chrome.runtime.getURL("vendor/") },
  });
  return worker;
}

function callWorker(payload) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ensureWorker().postMessage({ id, ...payload });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen-sponsorskip") return;
  if (msg.type === "localDetect") {
    console.log(`[sponsor_skip:offscreen] detecting over ${msg.cues?.length || 0} cues…`);
    callWorker({
      type: "detect",
      model: msg.model,
      models: msg.models, // ordered fallback candidates for resilience
      device: msg.device,
      cues: msg.cues,
      opts: msg.opts || {},
    })
      .then((r) => {
        if (r.ok) {
          console.log(
            `[sponsor_skip:offscreen] done: ${r.segments.length} segment(s) (device: ${r.device}, ${r.ms}ms)`
          );
        } else {
          console.error("[sponsor_skip:offscreen] detect failed", r.error);
        }
        sendResponse(r);
      })
      .catch((err) => sendResponse({ ok: false, error: String(err?.stack || err) }));
    return true; // async response
  }
  if (msg.type === "prepareModel") {
    callWorker({ type: "prepareModel", model: msg.model, sha256: msg.sha256 })
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String(err?.stack || err) }));
    return true;
  }
  if (msg.type === "deleteModelCache") {
    callWorker({ type: "deleteModelCache", repo: msg.repo })
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String(err?.stack || err) }));
    return true;
  }
});
