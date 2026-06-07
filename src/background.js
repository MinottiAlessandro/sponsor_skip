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
  // Resolve which model the detector should load: the advanced custom override wins;
  // otherwise the active catalog model's repo (built-in default => "model").
  const customModel = (s.customModel || "").trim();
  let modelRepo = "model";
  if (customModel) {
    modelRepo = customModel;
  } else {
    // Cached-only catalog read — detection must never block on a network fetch.
    const { catalog } = await chrome.storage.local.get("catalog");
    const cat = catalog || (await bundledCatalog());
    const entry = (cat.models || []).find((m) => m.id === (s.modelId || DEFAULTS.modelId));
    if (entry && !entry.builtin) modelRepo = entry.repo;
  }
  return {
    detector: s.detector || DEFAULTS.detector,
    device: s.device === "webgpu" ? "webgpu" : "wasm", // on-device model runtime (CPU/GPU)
    modelRepo, // "model" = built-in bundled weights; otherwise an HF repo id / URL
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
// Model catalog + downloads (selectable on-device models)
// --------------------------------------------------------------------------- //
// The catalog lives on Hugging Face so new/better models can be offered without a
// Web Store update; a bundled copy is the offline fallback. Models themselves are
// downloaded on demand (their weights are data, not code) and cached by the worker.
const CATALOG_REMOTE_URL =
  "https://huggingface.co/AlessandroMino/sponsor-skip-models/resolve/main/models.json";
const CATALOG_BUNDLED = "models/catalog.json";
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000; // re-fetch the remote catalog after 6h

let _bundledCatalog = null;
async function bundledCatalog() {
  if (!_bundledCatalog) {
    const res = await fetch(chrome.runtime.getURL(CATALOG_BUNDLED));
    _bundledCatalog = await res.json();
  }
  return _bundledCatalog;
}

// The built-in "default" ships *inside* the extension, so its metadata (size,
// version, languages) is authoritative from the bundled catalog — a remote/cached
// catalog must never mask the model the user actually has installed. The remote
// catalog only contributes the *other* (downloadable) models. If we later move the
// default off-bundle, just drop it from models/catalog.json and the remote default
// flows through untouched.
async function withBundledDefault(cat) {
  const bundled = await bundledCatalog();
  const def = bundled.models.find((m) => m.id === "default");
  if (!def) return cat; // no bundled default -> honor whatever the catalog has
  const models = [def, ...(cat?.models || []).filter((m) => m.id !== "default")];
  return { schemaVersion: cat?.schemaVersion || 1, models };
}

async function mergeCatalog(remote) {
  return withBundledDefault({ schemaVersion: remote?.schemaVersion || 1, models: remote?.models || [] });
}

async function loadCatalog(force) {
  const { catalog, catalogAt } = await chrome.storage.local.get(["catalog", "catalogAt"]);
  // Always overlay the bundled default so a cached catalog can't keep showing a
  // stale built-in size/version after the bundled model is swapped.
  if (!force && catalog && catalogAt && Date.now() - catalogAt < CATALOG_TTL_MS)
    return withBundledDefault(catalog);
  try {
    const res = await fetch(CATALOG_REMOTE_URL, { cache: "no-store" }); // needs HF host perm
    if (res.ok) {
      const merged = await mergeCatalog(await res.json());
      await chrome.storage.local.set({ catalog: merged, catalogAt: Date.now() });
      return merged;
    }
  } catch { /* offline / not created yet / no permission — fall back below */ }
  if (catalog) return withBundledDefault(catalog); // last good
  // Persist the bundled fallback so we don't retry the (blocked) remote fetch on
  // every call; the user's "Refresh" forces a fresh attempt once HF is reachable.
  const bundled = await bundledCatalog();
  await chrome.storage.local.set({ catalog: bundled, catalogAt: Date.now() });
  return bundled;
}

// Catalog + per-model state (active / downloaded / update available) for the popup.
async function getModels() {
  const catalog = await loadCatalog(false);
  const { settings, downloaded = {}, downloadState, modelNotice } = await chrome.storage.local.get([
    "settings", "downloaded", "downloadState", "modelNotice",
  ]);
  const activeId = settings?.modelId || DEFAULTS.modelId;
  const models = (catalog.models || []).map((m) => ({
    ...m,
    active: m.id === activeId,
    downloaded: !!m.builtin || !!downloaded[m.id],
    updateAvailable: !m.builtin && downloaded[m.id] && downloaded[m.id].version !== m.version,
  }));
  return { models, downloadState: downloadState || null, modelNotice: modelNotice || null };
}

// Persist + broadcast the single in-flight download's state (so a reopened popup can
// resume the progress view). Throttled on pct so we don't hammer storage.
let _lastPct = -10;
async function setDownloadState(state) {
  if (state) await chrome.storage.local.set({ downloadState: state });
  else await chrome.storage.local.remove("downloadState");
  _lastPct = state?.pct ?? -10;
  chrome.runtime.sendMessage({ type: "downloadStateChanged" }).catch(() => {});
}

let downloadingId = null; // at most one download at a time
async function downloadModel(id) {
  const catalog = await loadCatalog(false);
  const m = (catalog.models || []).find((x) => x.id === id);
  if (!m) throw new Error("Unknown model");
  if (m.builtin) return; // nothing to fetch
  if (downloadingId && downloadingId !== id) throw new Error("Another download is in progress");
  downloadingId = id;
  await setDownloadState({ id, pct: 0, status: "downloading" });
  try {
    await ensureOffscreen();
    const r = await sendToOffscreen(
      { target: "offscreen-sponsorskip", type: "prepareModel", model: m.repo, sha256: m.sha256 },
      10 * 60 * 1000 // big weights on a slow link
    );
    if (!r?.ok) throw new Error(r?.error || "download failed");
    const { downloaded = {} } = await chrome.storage.local.get("downloaded");
    downloaded[id] = { version: m.version, bytes: (m.sizeMB || 0) * 1024 * 1024, at: Date.now() };
    await chrome.storage.local.set({ downloaded });
    await setDownloadState(null);
  } catch (err) {
    await setDownloadState({ id, status: "error", error: String(err?.message || err) });
    throw err;
  } finally {
    downloadingId = null;
  }
}

async function deleteModel(id) {
  const catalog = await loadCatalog(false);
  const m = (catalog.models || []).find((x) => x.id === id);
  if (!m) throw new Error("Unknown model");
  if (m.builtin) throw new Error("The built-in model can't be deleted");
  await ensureOffscreen();
  const r = await sendToOffscreen(
    { target: "offscreen-sponsorskip", type: "deleteModelCache", repo: m.repo },
    60 * 1000
  );
  if (!r?.ok) throw new Error(r?.error || "delete failed");
  const { downloaded = {} } = await chrome.storage.local.get("downloaded");
  delete downloaded[id];
  await chrome.storage.local.set({ downloaded });
}

// Ordered models to try for detection: the chosen one, then the built-in default,
// then any other downloaded model. An evicted/removed active model fails to load, so
// the worker walks this list and degrades gracefully instead of dead-ending.
async function resolveModelCandidates(cfg) {
  const list = [cfg.modelRepo];
  if (cfg.modelRepo !== "model") list.push("model"); // built-in is the most reliable fallback
  const { catalog, downloaded = {} } = await chrome.storage.local.get(["catalog", "downloaded"]);
  const cat = catalog || (await bundledCatalog());
  for (const m of cat.models || []) {
    if (!m.builtin && downloaded[m.id] && m.repo && !list.includes(m.repo)) list.push(m.repo);
  }
  return list;
}

// Record (or clear) a notice when detection had to fall back off the chosen model, so
// the popup can tell the user their model is missing without breaking the result.
async function noteModelOutcome(cfg, resp) {
  if (resp.fellBack && resp.model && resp.model !== cfg.modelRepo) {
    const { catalog } = await chrome.storage.local.get("catalog");
    const cat = catalog || (await bundledCatalog());
    const nameOf = (repo) =>
      (cat.models || []).find((m) => m.repo === repo)?.name || (repo === "model" ? "built-in default" : repo);
    await chrome.storage.local.set({
      modelNotice: `Couldn't load “${nameOf(cfg.modelRepo)}” — used ${nameOf(resp.model)} instead. Re-download it below if this keeps happening.`,
    });
  } else {
    const { modelNotice } = await chrome.storage.local.get("modelNotice");
    if (modelNotice) await chrome.storage.local.remove("modelNotice"); // a clean run clears it
  }
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
  console.log(`[sponsor_skip:bg] POST ${cfg.endpoint} model=${cfg.model} promptChars=${prompt.length}`);
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
    if (!ok) console.warn(`[sponsor_skip:bg] dropped ${(s.end - s.start).toFixed(0)}s segment (> ${maxSeconds}s guard)`);
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
      uuid: s.UUID, // identifies this exact segment so the user can vote on it
      locked: s.locked === 1, // moderator-locked: votes won't change it
    }))
    .sort((a, b) => a.start - b.start);
}

// --------------------------------------------------------------------------- //
// SponsorBlock contribution — voting (Phase 1) + submitting model finds (Phase 3)
// --------------------------------------------------------------------------- //
const SB_VOTE_API = "https://sponsor.ajay.app/api/voteOnSponsorTime";
// Identify our extension as the submission source so SponsorBlock can see (and
// evaluate) model-origin contributions rather than them looking like manual ones.
const SB_USER_AGENT = `sponsor_skip/${chrome.runtime.getManifest().version}`;

// A private, locally-stored SponsorBlock identity, generated lazily on the first
// vote so users who never contribute never get one. SponsorBlock derives the public
// ID as sha256(this); we only ever send the private value and never display it.
async function getOrCreateUserID() {
  const { sbUserID } = await chrome.storage.local.get("sbUserID");
  if (sbUserID) return sbUserID;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""); // 64 hex chars
  await chrome.storage.local.set({ sbUserID: id });
  return id;
}

// Up/down vote an existing SponsorBlock segment by UUID. type: 1 = up, 0 = down.
async function voteSponsorBlock(uuid, type) {
  const userID = await getOrCreateUserID();
  const params = new URLSearchParams({ UUID: uuid, userID, type: String(type) });
  const res = await fetch(`${SB_VOTE_API}?${params}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 403 is the common "vote rejected" (e.g. segment locked / rate limited).
    throw new Error(`${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
  }
}

// Submit a (user-confirmed) model segment to SponsorBlock's public database. The
// popup gates this behind an explicit confirm, so by here the user has vouched for
// the boundaries. We still dedup against what's already on SponsorBlock to avoid
// polluting it with near-duplicates. Returns the new segment's UUID when the API
// gives us one. Throws a readable message on rejection (duplicate / rate-limit / …).
async function submitSponsorBlock(videoId, segment) {
  const start = Number(segment.start);
  const end = Number(segment.end);
  if (!(end > start)) throw new Error("Invalid segment bounds.");

  // Dedup: refuse if an existing SponsorBlock segment meaningfully overlaps this one.
  let existing = [];
  try { existing = await fetchSponsorBlock(videoId, null); } catch { /* network — let server dedup */ }
  const dupThreshold = Math.min(2, (end - start) * 0.3); // >2s OR >30% overlap = duplicate
  const overlaps = existing.some((s) => Math.min(s.end, end) - Math.max(s.start, start) > dupThreshold);
  if (overlaps) throw new Error("A similar segment is already on SponsorBlock.");

  const userID = await getOrCreateUserID();
  const res = await fetch(SB_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoID: videoId,
      userID,
      userAgent: SB_USER_AGENT,
      segments: [{ segment: [start, end], category: segment.category || "sponsor", actionType: "skip" }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }
  // Success: pull the new UUID out of the response if present (shape has varied).
  let uuid = null;
  try {
    const out = await res.json();
    const arr = Array.isArray(out) ? out : out?.segments;
    uuid = arr?.[0]?.UUID || arr?.[0]?.uuid || null;
  } catch { /* some deployments return an empty body on 200 */ }
  return { uuid };
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
  const candidates = await resolveModelCandidates(cfg);
  const payload = {
    target: "offscreen-sponsorskip", type: "localDetect", cues, opts,
    model: candidates[0], // "model" = built-in; otherwise an HF repo id / URL
    models: candidates, // ordered fallbacks if the chosen model can't load (evicted/removed)
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
        console.log(`[sponsor_skip:bg] offscreen not ready (attempt ${attempt + 1}), retrying…`);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw err; // a real error (timeout, detect failure)
    }
  }
  if (!resp) throw lastErr || new Error("offscreen unreachable");
  if (!resp.ok) throw new Error(resp.error || "local detect failed");
  await noteModelOutcome(cfg, resp); // surface (or clear) a "had to fall back" notice
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
          console.log(`[sponsor_skip:bg] SponsorBlock hit: ${sb.length} segment(s)`);
          await saveResult(videoId, title, sb, "sponsorblock");
          return { segments: sb, source: "sponsorblock" };
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        console.warn("[sponsor_skip:bg] SponsorBlock lookup failed", err);
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
      console.log(`[sponsor_skip:bg] abort ${msg.videoId}`);
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

  // Cast an up/down vote on a SponsorBlock segment (from the popup's segment list).
  if (msg?.type === "sbVote") {
    (async () => {
      try {
        await voteSponsorBlock(msg.uuid, msg.voteType);
        sendResponse({ ok: true });
      } catch (err) {
        console.warn("[sponsor_skip:bg] SponsorBlock vote failed:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // async response
  }

  // Submit a user-confirmed model segment to SponsorBlock (Phase 3).
  if (msg?.type === "sbSubmit") {
    (async () => {
      try {
        const { uuid } = await submitSponsorBlock(msg.videoId, msg.segment);
        sendResponse({ ok: true, uuid });
      } catch (err) {
        console.warn("[sponsor_skip:bg] SponsorBlock submit failed:", err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // async response
  }

  // ---- model catalog + downloads (from the Detector tab's model manager) ---- //
  if (msg?.type === "getModels" || msg?.type === "refreshCatalog") {
    (async () => {
      try {
        if (msg.type === "refreshCatalog") await loadCatalog(true);
        sendResponse(await getModels());
      } catch (err) {
        sendResponse({ models: [], error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === "downloadModel" || msg?.type === "deleteModel") {
    (async () => {
      try {
        await (msg.type === "downloadModel" ? downloadModel(msg.id) : deleteModel(msg.id));
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  // Streaming progress from the offscreen worker — persist (throttled, no broadcast)
  // so a reopened popup resumes the bar. An open popup already updates live from this
  // same message, so we don't trigger a full re-render here.
  if (msg?.type === "downloadProgress") {
    if (downloadingId && Math.abs((msg.pct ?? 0) - _lastPct) >= 3) {
      _lastPct = msg.pct ?? 0;
      chrome.storage.local.set({ downloadState: { id: downloadingId, pct: msg.pct, status: "downloading" } });
    }
    return; // no response
  }

  if (msg?.type !== "detect") return;

  console.log(`[sponsor_skip:bg] detect request: ${msg.videoId} (${msg.cues?.length} cues)`);
  if (active) active.controller.abort(); // supersede any in-flight detection
  const controller = new AbortController();
  active = { videoId: msg.videoId, controller };
  setBadge(tabId, "…", "#1a73e8");

  detect(msg, controller.signal)
    .then((r) => {
      if (r.needTranscript) {
        // discovery missed; keep the "…" badge — the detection-phase request follows
        console.log(`[sponsor_skip:bg] no fast-path for ${msg.videoId}; awaiting transcript`);
      } else {
        const n = r.segments?.length || 0;
        console.log(`[sponsor_skip:bg] detect done: ${n} segment(s)`, r.segments);
        setBadge(tabId, String(n), n ? "#2e7d32" : "#5f6368");
        chrome.storage.local.remove("lastError"); // a clean result clears any prior error
      }
      sendResponse(r);
    })
    .catch((err) => {
      if (controller.signal.aborted) {
        console.log(`[sponsor_skip:bg] detect aborted: ${msg.videoId}`);
        setBadge(tabId, "");
        sendResponse({ aborted: true });
      } else {
        const reason = String(err?.message || err);
        console.warn("[sponsor_skip:bg] detect failed:", err);
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
