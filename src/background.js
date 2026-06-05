// background.js — service worker. Receives transcripts from the content script,
// runs sponsor detection (the bundled on-device model by default, or a local
// Ollama LLM in dev), maps the result back to timestamps, and caches per video.

// Detector-side config + LLM-path tuning constants. The user-facing setting
// defaults that overlap here (detector/endpoint/model/maxSegmentSeconds) mirror
// src/defaults.js — keep those shared keys in sync if you change them.
const DEFAULTS = {
  // "local" = bundled fine-tuned classifier via Transformers.js (no server,
  // private, multilingual). "ollama" = the original local-LLM dev backend.
  detector: "local",
  endpoint: "http://localhost:11434/api/generate",
  model: "gemma4:latest",
  // overall safety cap on total lines analyzed (bounds runtime on very long videos)
  maxLines: 3000,
  numCtx: 8192, // chunks are small, so a modest context fits with output room
  window: 350, // chunk size in transcript lines
  overlap: 70, // overlap so a sponsor straddling a boundary stays recoverable
  // Sanity guard: a single detected segment longer than this is almost always an
  // error (a model artifact or LLM hallucination) — drop it rather than risk
  // skipping real content. Applied to both detectors.
  maxSegmentSeconds: 300,
};

async function getDetectorConfig() {
  const stored = await chrome.storage.local.get("settings");
  const s = stored.settings || {};
  return {
    detector: s.detector || DEFAULTS.detector,
    device: s.device === "webgpu" ? "webgpu" : "wasm", // on-device model runtime (CPU/GPU)
    customModel: (s.customModel || "").trim(), // advanced: on-device model id/URL ("" = bundled)
    endpoint: s.endpoint || DEFAULTS.endpoint,
    model: s.model || DEFAULTS.model,
    maxLines: DEFAULTS.maxLines,
    numCtx: DEFAULTS.numCtx,
    window: DEFAULTS.window,
    overlap: DEFAULTS.overlap,
    maxSegmentSeconds: s.maxSegmentSeconds ?? DEFAULTS.maxSegmentSeconds,
    useSponsorBlock: s.useSponsorBlock !== false, // default on
  };
}

// --------------------------------------------------------------------------- //
// Prompt building / response parsing
// --------------------------------------------------------------------------- //
// We ask the model to QUOTE the sponsor text verbatim (not emit line numbers or
// timestamps) and map those quotes back to cue timestamps ourselves. Evidence:
// a 4B model recognizes sponsors well but fails at line-index arithmetic, and
// Ollama's format:"json" grammar mode collapses it to an empty array — so we use
// free-text output + extractJSON instead.
function buildPrompt(cues, title, lang) {
  const text = cues.map((c) => c.text).join("\n");
  return `You find "ad segments" in a YouTube transcript: parts that are NOT the actual content.

Categories:
- "sponsor": a paid ad for a third-party product/service.
- "selfpromo": the creator promoting their OWN merch, Patreon, courses, or membership.
- "interaction": brief reminders to like, comment, or subscribe.

CRUCIAL — find the REAL START of the ad. A sponsor read almost always opens with a SEGUE before the brand is named: a transition phrase, a rhetorical question, an anecdote, or a "problem" the creator raises only to introduce the product. Examples of segue openers: "but first…", "you know what's annoying?", "have you ever…", "speaking of…", "this is made possible by…". The ad BEGINS at that segue, NOT at the brand name. Set quote_start to the first words of the segue, and quote_end to the end of the ad (the call to action, promo code, link, or "anyway, back to…").

Do NOT mark normal content or genuinely on-topic discussion.

Output ONLY a JSON object, nothing else:
{"segments":[{"category":"sponsor|selfpromo|interaction","quote_start":"<first ~6 words of the SEGUE that starts the ad, verbatim>","quote_end":"<last ~6 words of the ad, verbatim>","confidence":<0..1>}]}
quote_start and quote_end MUST be copied EXACTLY from the transcript text. If there are none, return {"segments":[]}.

Example transcript: "...and that wraps up the build. Speaking of staying safe, have you ever worried about hackers on public wifi? Well that's why I use NordVPN. Use code TEST at nordvpn.com. Anyway, back to the PC..."
Correct answer: quote_start "Speaking of staying safe, have you", quote_end "code TEST at nordvpn.com." — note it starts at the segue, NOT at "that's why I use NordVPN".

Video title: ${title || "(unknown)"}
Transcript language: ${lang || "unknown"}

Transcript:
${text}`;
}

function extractJSON(text) {
  // Models sometimes wrap JSON in prose or fences; grab the first {...} block.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

// --- quote → timestamp mapping ------------------------------------------- //
const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(Boolean);

// Build a single normalized string of all cue texts + the char offset where
// each cue begins, so we can map any matched character back to its cue.
function buildIndex(cues) {
  let joined = "";
  const starts = [];
  cues.forEach((c, i) => {
    starts.push(joined.length);
    joined += (i ? " " : "") + norm(c.text);
  });
  return { joined, starts };
}

function charToCue(starts, pos) {
  let lo = 0,
    hi = starts.length - 1,
    ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// Last-resort fuzzy locate: the cue whose words best overlap the quote. Handles
// the model paraphrasing / dropping a word instead of copying verbatim.
function fuzzyCue(cues, quote) {
  const qw = new Set(words(quote));
  if (!qw.size) return -1;
  let best = 0,
    bi = -1;
  cues.forEach((c, i) => {
    const cw = words(c.text);
    let hits = 0;
    for (const w of cw) if (qw.has(w)) hits++;
    const score = hits / qw.size; // fraction of the quote's words present
    if (score > best) {
      best = score;
      bi = i;
    }
  });
  return best >= 0.5 ? bi : -1; // need at least half the quote's words
}

// Find the cue index for a quote. `fromEnd` maps to the cue containing the
// quote's last char. Tries exact → leading sub-phrase → fuzzy token overlap.
function findCue(index, cues, quote, fromEnd) {
  const q = norm(quote);
  if (!q) return -1;
  let pos = index.joined.indexOf(q);
  if (pos !== -1) return charToCue(index.starts, fromEnd ? pos + q.length - 1 : pos);

  const w = q.split(" ");
  for (let n = Math.min(5, w.length); n >= 2; n--) {
    const sub = w.slice(0, n).join(" ");
    pos = index.joined.indexOf(sub);
    if (pos !== -1) return charToCue(index.starts, fromEnd ? pos + sub.length - 1 : pos);
  }
  return fuzzyCue(cues, quote);
}

function toSegments(parsed, cues) {
  if (!parsed || !Array.isArray(parsed.segments)) return [];
  const index = buildIndex(cues);
  const out = [];
  for (const s of parsed.segments) {
    let a = findCue(index, cues, s.quote_start, false);
    let b = findCue(index, cues, s.quote_end, true);
    if (a === -1 && b === -1) continue; // couldn't locate the quote
    if (a === -1) a = b;
    if (b === -1) b = a;
    if (b < a) [a, b] = [b, a];
    const category = ["sponsor", "selfpromo", "interaction"].includes(s.category)
      ? s.category
      : "sponsor";
    let confidence = Number(s.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.75;
    confidence = Math.max(0, Math.min(1, confidence));
    out.push({
      start: cues[a].start,
      end: cues[b].start + (cues[b].duration || 0),
      category,
      confidence,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// LLM call (Ollama /api/generate). We deliberately do NOT set format:"json" — its
// grammar mode collapses small models to an empty array, so we parse JSON out of
// the free-text response instead (see extractJSON).
// --------------------------------------------------------------------------- //
async function callLLM(cfg, prompt, signal) {
  console.log(`[ad_skip:bg] POST ${cfg.endpoint} model=${cfg.model} promptChars=${prompt.length}`);
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      prompt,
      stream: false,
      // NOTE: deliberately NOT using format:"json" — its grammar constraint
      // collapses small models to an empty array. We parse JSON from free text.
      options: { temperature: 0, num_ctx: cfg.numCtx },
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Ollama returns the text in `response`; be lenient about shape.
  return data.response ?? data.message?.content ?? "";
}

// --------------------------------------------------------------------------- //
// Chunking + merge (long transcripts: small overlapping windows detect better
// than one huge prompt, and stay within a modest context window)
// --------------------------------------------------------------------------- //
function makeChunks(cues, window, overlap) {
  if (cues.length <= window) return [cues];
  const step = Math.max(1, window - overlap);
  const chunks = [];
  for (let i = 0; i < cues.length; i += step) {
    chunks.push(cues.slice(i, i + window));
    if (i + window >= cues.length) break;
  }
  return chunks;
}

// Drop implausibly long segments (likely hallucinations) so we never skip huge
// chunks of real content. Applied to LLM output only, not SponsorBlock labels.
function dropLongSegments(segs, maxSeconds) {
  return segs.filter((s) => {
    const ok = s.end - s.start <= maxSeconds;
    if (!ok) console.warn(`[ad_skip:bg] dropped ${(s.end - s.start).toFixed(0)}s segment (> ${maxSeconds}s guard)`);
    return ok;
  });
}

function mergeSegments(segs, gap = 5) {
  const out = [];
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.category === last.category && s.start <= last.end + gap) {
      last.end = Math.max(last.end, s.end);
      last.confidence = Math.max(last.confidence, s.confidence);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// SponsorBlock fast-path — human-verified segments, queried privately by the
// first 4 chars of the SHA-256 of the video id (server never sees the full id).
// --------------------------------------------------------------------------- //
const SB_API = "https://sponsor.ajay.app/api/skipSegments";
const SB_CATEGORIES = ["sponsor", "selfpromo", "interaction"];

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchSponsorBlock(videoId, signal) {
  const prefix = (await sha256Hex(videoId)).slice(0, 4);
  const cats = encodeURIComponent(JSON.stringify(SB_CATEGORIES));
  const res = await fetch(`${SB_API}/${prefix}?categories=${cats}`, { signal });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`sponsorblock ${res.status}`);
  const data = await res.json();
  return data
    .filter((row) => row.videoID === videoId)
    .flatMap((row) => row.segments || [])
    .filter((s) => Array.isArray(s.segment))
    .map((s) => ({
      start: s.segment[0],
      end: s.segment[1],
      category: SB_CATEGORIES.includes(s.category) ? s.category : "sponsor",
      confidence: 1, // human-verified
    }))
    .sort((a, b) => a.start - b.start);
}

// --------------------------------------------------------------------------- //
// Detection entry point (with cache)
// --------------------------------------------------------------------------- //
async function saveResult(videoId, title, segments, source, device, ms) {
  const data = {
    [`seg:${videoId}`]: segments,
    [`src:${videoId}`]: source,
    lastResult: { videoId, title, count: segments.length, segments, source, device, ms, at: Date.now() },
  };
  // Only the on-device model has a backend + timing; cache them together so a cache
  // hit can show them too.
  if (device) data[`dev:${videoId}`] = { device, ms };
  await chrome.storage.local.set(data);
}

// --------------------------------------------------------------------------- //
// Local detector (bundled fine-tuned classifier) — runs in an offscreen document
// because the service worker can't keep the model resident.
// --------------------------------------------------------------------------- //
const OFFSCREEN_PATH = "src/offscreen.html";
let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const has = await chrome.offscreen.hasDocument?.();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS"],
        justification: "Run the on-device sponsor-detection model (WASM/ONNX).",
      });
    }
  })();
  return offscreenReady;
}

function sendToOffscreen(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`offscreen timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    chrome.runtime.sendMessage(payload, (r) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message)); // e.g. listener not ready yet
      else resolve(r);
    });
  });
}

async function localDetect(cues, cfg, signal) {
  await ensureOffscreen();
  const opts = { maxSegmentSeconds: cfg.maxSegmentSeconds };
  const payload = {
    target: "offscreen-adskip", type: "localDetect", cues, opts,
    model: cfg.customModel || undefined, // undefined -> bundled model
    device: cfg.device, // "wasm" (CPU) | "webgpu" (GPU); offscreen falls back if needed
  };

  // The offscreen module loads (and registers its listener) asynchronously after
  // createDocument resolves, so the first send can hit "no receiving end". Retry a
  // few times. The model-load itself can be slow on first run -> generous timeout.
  let resp, lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    try {
      resp = await sendToOffscreen(payload, 120000);
      break;
    } catch (err) {
      lastErr = err;
      if (/Receiving end does not exist|message port closed/i.test(err.message)) {
        console.log(`[ad_skip:bg] offscreen not ready (attempt ${attempt + 1}), retrying…`);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw err; // a real error (timeout, detect failure)
    }
  }
  if (!resp) throw lastErr || new Error("offscreen unreachable");
  if (!resp.ok) throw new Error(resp.error || "local detect failed");
  // device = backend actually used; ms = inference time on it
  return { segments: resp.segments, device: resp.device, ms: resp.ms };
}

async function detect({ videoId, title, lang, cues }, signal) {
  const cacheKey = `seg:${videoId}`;
  const srcKey = `src:${videoId}`;
  const devKey = `dev:${videoId}`;
  const cached = await chrome.storage.local.get([cacheKey, srcKey, devKey]);
  if (cached[cacheKey]) {
    const meta = cached[devKey] || {}; // { device, ms } for local results
    return { segments: cached[cacheKey], cached: true, source: cached[srcKey], device: meta.device, ms: meta.ms };
  }

  const cfg = await getDetectorConfig();

  // Discovery phase (no transcript sent yet): try the SponsorBlock fast-path. If
  // it misses, tell the content script to fetch the transcript and come back.
  if (!cues) {
    if (cfg.useSponsorBlock) {
      try {
        const sb = await fetchSponsorBlock(videoId, signal);
        if (sb.length) {
          console.log(`[ad_skip:bg] SponsorBlock hit: ${sb.length} segment(s)`);
          await saveResult(videoId, title, sb, "sponsorblock");
          return { segments: sb, source: "sponsorblock" };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn("[ad_skip:bg] SponsorBlock lookup failed", err);
      }
    }
    return { needTranscript: true };
  }

  // Detection phase (transcript provided): the fast path already missed.
  const trimmed = cues.slice(0, cfg.maxLines);

  if (cfg.detector === "local") {
    const { segments, device, ms } = await localDetect(trimmed, cfg, signal);
    await saveResult(videoId, title, segments, "local", device, ms);
    return { segments, source: "local", device, ms };
  }

  // Ollama LLM backend (dev/fallback).
  const chunks = makeChunks(trimmed, cfg.window, cfg.overlap);
  const all = [];
  for (const sub of chunks) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    // sub cues carry absolute timestamps, so mapped segment times are absolute
    const raw = await callLLM(cfg, buildPrompt(sub, title, lang), signal);
    all.push(...toSegments(extractJSON(raw), sub));
  }
  const segments = dropLongSegments(mergeSegments(all), cfg.maxSegmentSeconds);

  await saveResult(videoId, title, segments, "llm");
  return { segments, source: "llm" };
}

// Toolbar icon badge per tab: "…" while working, the sponsor count when done.
// Gated on the statusIndicator setting; when disabled, calls clear the badge.
let badgeEnabled = true;
async function loadBadgePref() {
  const { settings } = await chrome.storage.local.get("settings");
  const v = settings?.statusIndicator ?? "both";
  badgeEnabled = v === "both" || v === "badge";
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) loadBadgePref();
});
loadBadgePref();

function setBadge(tabId, text, color) {
  if (tabId == null) return;
  if (!badgeEnabled) text = ""; // disabled → keep the badge cleared
  chrome.action.setBadgeText({ text, tabId });
  if (text && color) chrome.action.setBadgeBackgroundColor({ color, tabId });
}

// At most one detection runs at a time; a new request or an abort cancels it,
// so a user flipping through videos can't pile up a queue of detections.
let active = null; // { videoId, controller }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (msg?.type === "abort") {
    if (active && active.videoId === msg.videoId) {
      console.log(`[ad_skip:bg] abort ${msg.videoId}`);
      active.controller.abort();
      active = null;
    }
    setBadge(tabId, ""); // clear the working indicator
    return; // no response
  }

  // Content-script-side failure (transcript/caption fetch): surface it on the icon
  // and stash the reason for the popup to expand.
  if (msg?.type === "detectError") {
    setBadge(tabId, "!", "#c5221f");
    chrome.storage.local.set({ lastError: { videoId: msg.videoId, reason: msg.reason, at: Date.now() } });
    return;
  }

  // Debug hook (debug/test.html): run the on-device model on supplied cues via the
  // real production path (offscreen). Lets us verify in-browser inference without
  // depending on the live transcript fetch.
  if (msg?.type === "localDetectTest") {
    (async () => {
      try {
        const cfg = await getDetectorConfig();
        const t0 = Date.now();
        const { segments, device } = await localDetect(msg.cues, cfg, null);
        sendResponse({ ok: true, segments, ms: Date.now() - t0, device });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.stack || err) });
      }
    })();
    return true;
  }

  if (msg?.type !== "detect") return;

  console.log(`[ad_skip:bg] detect request: ${msg.videoId} (${msg.cues?.length} cues)`);
  if (active) active.controller.abort(); // supersede any in-flight detection
  const controller = new AbortController();
  active = { videoId: msg.videoId, controller };
  setBadge(tabId, "…", "#1a73e8");

  detect(msg, controller.signal)
    .then((r) => {
      if (r.needTranscript) {
        // discovery missed; keep the "…" badge — the detection-phase request follows
        console.log(`[ad_skip:bg] no fast-path for ${msg.videoId}; awaiting transcript`);
      } else {
        const n = r.segments?.length || 0;
        console.log(`[ad_skip:bg] detect done: ${n} segment(s)`, r.segments);
        setBadge(tabId, String(n), n ? "#2e7d32" : "#5f6368");
        chrome.storage.local.remove("lastError"); // a clean result clears any prior error
      }
      sendResponse(r);
    })
    .catch((err) => {
      if (controller.signal.aborted) {
        console.log(`[ad_skip:bg] detect aborted: ${msg.videoId}`);
        setBadge(tabId, "");
        sendResponse({ aborted: true });
      } else {
        const reason = String(err?.message || err);
        console.warn("[ad_skip:bg] detect failed:", err);
        setBadge(tabId, "!", "#c5221f");
        chrome.storage.local.set({ lastError: { videoId: msg.videoId, reason, at: Date.now() } });
        sendResponse({ error: reason });
      }
    })
    .finally(() => {
      if (active && active.videoId === msg.videoId && active.controller === controller) {
        active = null;
      }
    });
  return true; // async response
});
