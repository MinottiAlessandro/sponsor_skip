// content.js — runs in the ISOLATED world on youtube.com.
// Orchestrates: inject MAIN-world script -> receive caption tracks -> fetch the
// transcript -> ask the background worker (the on-device model, or Ollama in dev)
// for sponsor segments -> run the skip controller + on-player UI.

const LANG_PRIORITY = ["en", "it", "es", "fr", "de"];

// DEFAULTS and filterSegments are provided by src/defaults.js, which the manifest
// loads as a content script just before this one (shared so the popup filters the
// same way).
let settings = { ...DEFAULTS };
let controller = null; // current SkipController
let currentVideoId = null;
let lastSource = null; // how the current video's segments were found
let lastDevice = null; // backend the on-device model ran on ("wasm"/"webgpu"), if local
let lastMs = null; // on-device model inference time in ms, if local
let lastRawSegments = []; // all detected segments (every category), pre-filter

// Friendly label for where a result came from (shown in the pill + popup).
function sourceLabel(source) {
  return (
    { sponsorblock: "SponsorBlock DB", local: "on-device model", llm: "local LLM" }[
      source
    ] || source
  );
}
let detectionAbort = null; // AbortController for the in-flight transcript fetch
let debounceTimer = null;
const DETECT_DEBOUNCE_MS = 700; // ignore videos the user flies past

// --------------------------------------------------------------------------- //
// Settings
// --------------------------------------------------------------------------- //
async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    controller?.updateSettings(settings);
    // Re-apply the category/confidence filter live so toggling e.g. "self-promo"
    // updates the timeline markers without re-analyzing or reloading.
    controller?.setSegments(filterSegments(lastRawSegments, settings));
    if (!pillEnabled()) hideStatus();
  }
});

// --------------------------------------------------------------------------- //
// MAIN-world injection + caption messages
// --------------------------------------------------------------------------- //
function injectPlayerReader() {
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("src/inject.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
}

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== "sponsor_skip" || d.type !== "video") return;
  console.log("[sponsor_skip] video message received:", {
    videoId: d.videoId,
    hasApiKey: !!d.apiKey,
  });
  // onVideo is synchronous (it schedules debounced detection); guard so a throw
  // can't bubble as an uncaught error in this listener.
  try {
    onVideo(d);
  } catch (err) {
    console.warn("[sponsor_skip] video handling", err);
  }
});

// --------------------------------------------------------------------------- //
// Transcript fetch — via InnerTube ANDROID client (un-gated caption URLs)
// --------------------------------------------------------------------------- //
// ANDROID first — its caption URLs aren't PO-token-gated. The others are
// fallbacks in case a client call fails or returns no captions.
const INNERTUBE_CLIENTS = [
  { clientName: "ANDROID", clientVersion: "20.10.38" },
  { clientName: "IOS", clientVersion: "20.10.4" },
  { clientName: "WEB", clientVersion: "2.20240620.05.00" },
];
// Stable public web InnerTube key; only a fallback if ytcfg didn't expose one.
const FALLBACK_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

async function fetchCaptionTracks(videoId, apiKey, signal) {
  const key = apiKey || FALLBACK_KEY;
  for (const client of INNERTUBE_CLIENTS) {
    let data;
    try {
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context: { client }, videoId }),
        signal,
      });
      if (!res.ok) continue;
      data = await res.json();
    } catch (err) {
      if (signal?.aborted) throw err; // user navigated away
      continue; // try the next client
    }
    const r = data?.captions?.playerCaptionsTracklistRenderer;
    const tracks = (r?.captionTracks || []).map((t) => ({
      baseUrl: t.baseUrl,
      lang: t.languageCode,
      kind: t.kind || null,
      name: t.name?.simpleText || t.name?.runs?.[0]?.text || "",
    }));
    if (tracks.length) {
      const audioLang =
        tracks[r?.audioTracks?.[0]?.defaultCaptionTrackIndex || 0]?.lang || null;
      console.log(`[sponsor_skip] caption tracks via ${client.clientName}: ${tracks.length}`);
      return { tracks, audioLang };
    }
  }
  return { tracks: [], audioLang: null }; // no captions on any client
}

function pickTrack(tracks, audioLang) {
  if (!tracks.length) return null;
  const score = (t) => {
    let s = 0;
    if (t.kind !== "asr") s += 100; // prefer human captions
    if (audioLang && t.lang === audioLang) s += 50;
    const idx = LANG_PRIORITY.indexOf((t.lang || "").slice(0, 2));
    if (idx !== -1) s += 20 - idx; // mild preference for our target langs
    return s;
  };
  return [...tracks].sort((a, b) => score(b) - score(a))[0];
}

async function fetchCues(track, signal) {
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "json3");
  console.log("[sponsor_skip] GET", url.toString());
  // YouTube rate-limits the caption endpoint; retry transient 429s with backoff.
  let res, body;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url.toString(), { credentials: "include", signal });
    body = await res.text();
    console.log(`[sponsor_skip] timedtext status=${res.status} bodyLength=${body.length}`);
    if (res.status !== 429 || attempt === 2) break;
    const wait = 800 * 2 ** attempt; // 0.8s, 1.6s
    console.warn(`[sponsor_skip] timedtext 429 — retrying in ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  }
  if (!res.ok) throw new Error(`timedtext ${res.status}`);
  if (!body.trim()) {
    console.warn("[sponsor_skip] timedtext returned an empty body");
    return [];
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    console.warn("[sponsor_skip] timedtext not JSON; first 200 chars:", body.slice(0, 200));
    throw e;
  }
  const cues = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const text = ev.segs
      .map((s) => s.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({
      text,
      start: (ev.tStartMs || 0) / 1000,
      duration: (ev.dDurationMs || 0) / 1000,
    });
  }
  return cues;
}

// --------------------------------------------------------------------------- //
// On-page status indicator — lets the user see, without clicking, whether we're
// still working or done.
// --------------------------------------------------------------------------- //
let statusEl = null;
let statusHideTimer = null;

function statusHost() {
  return document.querySelector(".html5-video-player") || document.body;
}

function pillEnabled() {
  const v = settings.statusIndicator ?? "both";
  return v === "both" || v === "page";
}

function setStatus(analyzing, text, autoHideMs, isError) {
  if (!pillEnabled()) return;
  clearTimeout(statusHideTimer);
  const host = statusHost();
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.className = "sponsorskip-status";
  }
  if (statusEl.parentElement !== host) host.appendChild(statusEl);
  statusEl.classList.toggle("done", !analyzing);
  statusEl.classList.toggle("error", !!isError);
  const icon = isError
    ? '<span class="sponsorskip-x">!</span>'
    : analyzing
    ? '<span class="sponsorskip-spinner"></span>'
    : '<span class="sponsorskip-check">✓</span>';
  statusEl.innerHTML = `${icon}<span>${text}</span>`;
  statusEl.style.display = "flex";
  positionStatus();
  // The "Includes paid promotion" overlay can appear a beat after we do; nudge.
  setTimeout(positionStatus, 400);
  setTimeout(positionStatus, 1200);
  if (autoHideMs) statusHideTimer = setTimeout(hideStatus, autoHideMs);
}

// Sit at the top-left of the player, but drop below YouTube's "Includes paid
// promotion" overlay when it's showing, so they never overlap.
function positionStatus() {
  if (!statusEl || statusEl.style.display === "none") return;
  const host = statusHost();
  const promo = host.querySelector?.(".ytp-paid-content-overlay");
  let top = 12, left = 12;
  if (promo && promo.offsetParent !== null && promo.getBoundingClientRect().height > 0) {
    const hr = host.getBoundingClientRect();
    const pr = promo.getBoundingClientRect();
    top = Math.max(12, pr.bottom - hr.top + 8); // sit just below the overlay
    left = Math.max(12, pr.left - hr.left); // and line our left edge up with it
  }
  statusEl.style.top = `${top}px`;
  statusEl.style.left = `${left}px`;
}

function hideStatus() {
  clearTimeout(statusHideTimer);
  if (statusEl) statusEl.style.display = "none";
}

// Surface a failure on the page pill AND the toolbar icon (popup expands it).
function reportError(videoId, reason) {
  console.warn("[sponsor_skip]", reason);
  setStatus(false, reason, 8000, true);
  chrome.runtime.sendMessage({ type: "detectError", videoId, reason }).catch(() => {});
}

// Cancel everything tied to a video we're leaving: the debounce, the local
// transcript fetch, and the background's running detection for it.
function abortInFlight(videoId) {
  clearTimeout(debounceTimer);
  if (detectionAbort) {
    detectionAbort.abort();
    detectionAbort = null;
  }
  if (videoId) {
    chrome.runtime.sendMessage({ type: "abort", videoId }).catch(() => {});
  }
}

// --------------------------------------------------------------------------- //
// Detection pipeline
// --------------------------------------------------------------------------- //
function onVideo(msg) {
  if (msg.videoId === currentVideoId) return; // already handled this video
  const previous = currentVideoId;
  currentVideoId = msg.videoId;

  controller?.destroy();
  controller = null;
  lastSource = null;
  lastDevice = null;
  lastMs = null;
  lastRawSegments = [];
  abortInFlight(previous); // stop work on the video we just left

  // Debounce: only process if the user stays here a moment (avoids queueing up
  // detection for videos they're quickly flipping through).
  debounceTimer = setTimeout(() => {
    runDetection(msg).catch((err) => console.warn("[sponsor_skip] detection", err));
  }, DETECT_DEBOUNCE_MS);
}

async function runDetection(msg) {
  if (msg.videoId !== currentVideoId) return; // superseded during the debounce
  detectionAbort = new AbortController();
  const signal = detectionAbort.signal;
  const stale = () => signal.aborted || msg.videoId !== currentVideoId;
  setStatus(true, "Analyzing sponsors…");

  // Phase 1: ask the background for cache + SponsorBlock first — no transcript
  // fetch needed unless this falls through to on-device detection.
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: "detect",
      videoId: msg.videoId,
      title: msg.title,
    });
  } catch (err) {
    if (!stale()) console.warn("[sponsor_skip] detect message failed", err);
    return;
  }
  if (stale()) return;

  // Phase 2: only fetch the transcript + run the detector when the fast path missed.
  if (resp && resp.needTranscript) {
    let tracks, audioLang;
    try {
      ({ tracks, audioLang } = await fetchCaptionTracks(msg.videoId, msg.apiKey, signal));
    } catch (err) {
      if (!stale()) reportError(msg.videoId, `Caption fetch failed: ${err?.message || err}`);
      return;
    }
    if (stale()) return;

    const track = pickTrack(tracks, audioLang);
    if (!track) {
      console.warn("[sponsor_skip] no usable caption track", tracks);
      reportError(msg.videoId, "No captions available for this video.");
      return;
    }
    console.log("[sponsor_skip] picked track:", track.lang, track.kind || "manual");

    let cues;
    try {
      cues = await fetchCues(track, signal);
    } catch (err) {
      if (!stale()) reportError(msg.videoId, `Transcript fetch failed: ${err?.message || err}`);
      return;
    }
    if (stale()) return;
    console.log(`[sponsor_skip] fetched ${cues.length} cues`);
    if (!cues.length) {
      reportError(msg.videoId, "No transcript available for this video.");
      return;
    }

    console.log("[sponsor_skip] requesting detection from background…");
    try {
      resp = await chrome.runtime.sendMessage({
        type: "detect",
        videoId: msg.videoId,
        title: msg.title,
        lang: track.lang,
        cues,
      });
    } catch (err) {
      if (!stale()) console.warn("[sponsor_skip] detect message failed", err);
      return;
    }
  }

  detectionAbort = null;
  if (stale()) return; // user navigated away while detection was running
  if (!resp || resp.aborted) return;
  if (resp.error) {
    console.warn("[sponsor_skip] detection error:", resp.error);
    setStatus(false, "Detection failed", 8000, true);
    return;
  }

  lastRawSegments = resp.segments || [];
  const segments = filterSegments(lastRawSegments, settings);
  lastSource = resp.source || null;
  lastDevice = resp.device || null;
  lastMs = resp.ms ?? null;
  console.log(`[sponsor_skip] ${segments.length} segment(s) for ${msg.videoId} (${lastSource || "?"}${lastDevice ? "/" + lastDevice : ""}${lastMs != null ? ", " + lastMs + "ms" : ""})`, segments);
  const n = segments.length;
  const via = n && lastSource ? ` · ${sourceLabel(lastSource)}` : "";
  setStatus(false, n ? `${n} sponsor${n > 1 ? "s" : ""} found${via}` : "No sponsors found", 5000);

  const video = document.querySelector("video.html5-main-video, video");
  if (!video) return;
  controller = new SkipController(video, segments, settings);
}

// --------------------------------------------------------------------------- //
// Skip controller + UI
// --------------------------------------------------------------------------- //
// YouTube parks buttons in the player's bottom-right that can collide with our skip
// button — the ad "Skip" button (during ads) and the "Jump ahead" / "Skip ▶▶" button
// (in the control bar, shown on hover). Their class names differ across YouTube builds
// and design systems, so rather than match names we hit-test the screen box our control
// occupies and find any small, visible player element sitting there that isn't ours.
// Returns that element's rect (the thing to clear), or null. `box` is in viewport
// coords; `plr` is the player rect (used to ignore full-size containers).
function ytBottomRightObstacle(player, plr, box) {
  const xs = [box.left + 6, (box.left + box.right) / 2, box.right - 6];
  const ys = [box.top + 6, (box.top + box.bottom) / 2, box.bottom - 6];
  let best = null;
  const seen = new Set();
  for (const x of xs) {
    for (const y of ys) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!player.contains(el)) continue;
        if (el.closest(".sponsorskip-btn, .sponsorskip-countdown, .sponsorskip-status, .sponsorskip-toast")) continue;
        const er = el.getBoundingClientRect();
        if (er.width <= 0 || er.height <= 0) continue;
        // Ignore big containers (the video, gradient, control bar, player itself) —
        // we only want a button/pill actually sitting at our control's height.
        if (er.width > plr.width * 0.5 || er.height > plr.height * 0.35) continue;
        if (el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) continue;
        if (!best || er.top < best.top) best = er; // highest top → clears all of them
      }
    }
  }
  return best;
}

class SkipController {
  constructor(video, segments, settings) {
    this.video = video;
    this.segments = segments;
    this.settings = settings;
    this.btn = null;
    this.activeSeg = null;
    this.ignored = new Set(); // segments the user cancelled the auto-skip on
    this.countdown = null; // { seg, timer, el }
    this.markers = [];
    this.onTime = this.onTime.bind(this);
    this.onLayout = this.renderMarkers.bind(this);
    this.markerObserver = null;
    this.video.addEventListener("timeupdate", this.onTime);
    this.video.addEventListener("loadedmetadata", this.onLayout);
    this.video.addEventListener("durationchange", this.onLayout);
    window.addEventListener("resize", this.onLayout);
    document.addEventListener("fullscreenchange", this.onLayout);
    this.ensureMarkers();
    this.observeBar();
    // YouTube's bottom-right buttons (ad "Skip" / "Jump ahead") can appear/vanish or
    // shift at any time, so poll as a backstop to keep our controls clear of them.
    this.bottomTicker = setInterval(() => this.positionBottomControls(), 500);
    // …and reposition the instant the player chrome changes: hovering reveals the
    // control bar and shifts YouTube's skip button up; entering/leaving an ad moves
    // it too. YouTube flags both via class changes (ytp-autohide, ad-showing) on the
    // player, so a class observer catches them immediately (no 500ms lag on hover).
    this.playerObserver = new MutationObserver(() => this.positionBottomControls());
    const pl = this.player();
    if (pl) this.playerObserver.observe(pl, { attributes: true, attributeFilter: ["class"] });
  }

  // YouTube rebuilds the progress bar (SPA nav, player chrome re-renders, ad
  // breaks), which silently wipes our appended markers. Watch the player chrome
  // and re-render whenever our markers get detached — so they appear/persist
  // without a page reload.
  observeBar(tries = 0) {
    const host = document.querySelector(".ytp-chrome-bottom") || this.player();
    if (!host) {
      if (tries < 20) setTimeout(() => this.observeBar(tries + 1), 500);
      return;
    }
    this.markerObserver = new MutationObserver(() => {
      if (!this.markers.length || !this.markers[0].isConnected) this.renderMarkers();
    });
    this.markerObserver.observe(host, { childList: true, subtree: true });
  }

  updateSettings(s) {
    this.settings = s;
    if (s.mode === "off") {
      this.hideButton();
      this.cancelCountdown();
    }
  }

  // Swap the active segment set (e.g. after a category toggle) and redraw markers.
  setSegments(segs) {
    this.segments = segs;
    this.activeSeg = null;
    this.ignored = new Set();
    this.renderMarkers();
  }

  currentSegment(t) {
    // small lead so we don't clip the first word of content after the segment
    return this.segments.find(
      (seg) => !this.ignored.has(seg) && t >= seg.start && t < seg.end - 0.2
    );
  }

  onTime() {
    const mode = this.settings.mode;
    if (mode === "off") return;
    if (mode === "auto") return this.handleAuto();

    // button mode
    const seg = this.currentSegment(this.video.currentTime);
    if (!seg) {
      if (this.activeSeg) {
        this.activeSeg = null;
        this.hideButton();
      }
      return;
    }
    if (seg !== this.activeSeg) {
      this.activeSeg = seg;
      this.showButton(seg);
    }
  }

  // ---- auto-skip with countdown (playback-driven) -------------------------- //
  handleAuto() {
    const t = this.video.currentTime;
    const delay = Math.max(0, Math.round(Number(this.settings.autoSkipDelay ?? 3)));
    const preroll = this.settings.countdownMode === "preroll";

    let target = null;
    let remaining = 0;
    for (const seg of this.segments) {
      if (this.ignored.has(seg)) continue;
      if (preroll) {
        if (t >= seg.start && t < seg.end) return this.doSkip(seg); // already in it
        if (t >= seg.start - delay && t < seg.start) {
          target = seg;
          remaining = Math.ceil(seg.start - t);
          break;
        }
      } else {
        if (t >= seg.start && t < seg.end - 0.2) {
          const skipAt = Math.min(seg.start + delay, seg.end);
          if (t >= skipAt) return this.doSkip(seg);
          target = seg;
          remaining = Math.ceil(skipAt - t);
          break;
        }
      }
    }

    if (!target) return this.cancelCountdown();
    if (delay === 0) return this.doSkip(target);
    this.showCountdown(target, remaining);
  }

  showCountdown(seg, remaining) {
    if (!this.countdown) {
      const el = document.createElement("div");
      el.className = "sponsorskip-countdown";
      el.addEventListener("click", () => {
        if (this.countdown) this.ignored.add(this.countdown.seg); // opt out of this one
        this.cancelCountdown();
      });
      this.player()?.appendChild(el);
      this.countdown = { seg, el };
    }
    this.countdown.seg = seg;
    this.countdown.el.innerHTML =
      `Auto-skip in ${Math.max(0, remaining)}s <span class="sponsorskip-cancel">✕ cancel</span>`;
    this.positionBottomControls();
  }

  doSkip(seg) {
    this.cancelCountdown();
    this.video.currentTime = seg.end;
    this.toast("Skipped sponsor");
  }

  cancelCountdown() {
    if (!this.countdown) return;
    this.countdown.el?.remove();
    this.countdown = null;
  }

  // ---- yellow progress-bar markers ----------------------------------------- //
  ensureMarkers(tries = 0) {
    if (this.renderMarkers()) return;
    if (tries < 20) setTimeout(() => this.ensureMarkers(tries + 1), 500);
  }

  renderMarkers() {
    const bar = document.querySelector(".ytp-progress-bar");
    const dur = this.video.duration;
    if (!bar || !dur || !isFinite(dur)) return false;
    this.markers.forEach((m) => m.remove());
    this.markers = this.segments.map((seg) => {
      const m = document.createElement("div");
      m.className = "sponsorskip-marker";
      m.style.left = `${(seg.start / dur) * 100}%`;
      m.style.width = `${((seg.end - seg.start) / dur) * 100}%`;
      bar.appendChild(m);
      return m;
    });
    return true;
  }

  player() {
    return (
      document.querySelector(".html5-video-player") ||
      this.video.parentElement
    );
  }

  // Lift the skip button / countdown above whatever YouTube is showing in the
  // bottom-right (ad "Skip" or "Jump ahead" button), so the two never overlap. No-op
  // when neither is visible or there's no obstacle (controls stay at the CSS default).
  positionBottomControls() {
    const cd = this.countdown?.el;
    const btnVisible = this.btn && this.btn.style.display !== "none";
    const anchor = btnVisible ? this.btn : cd;
    if (!anchor) return;
    const player = this.player();
    if (!player) return;
    const plr = player.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    // Probe the box our control occupies at its CSS-default home (bottom:70px) — NOT
    // wherever we may have already lifted it to, or moving out of the overlap would
    // "lose" the obstacle and we'd oscillate. Same width/height/right edge as now.
    const homeBottom = plr.bottom - 70;
    const box = { left: r.left, right: r.right, top: homeBottom - r.height, bottom: homeBottom };
    let bottom = 70; // CSS default
    const obstacle = ytBottomRightObstacle(player, plr, box);
    if (obstacle) bottom = Math.max(70, plr.bottom - obstacle.top + 12); // 12px gap above it
    if (btnVisible) this.btn.style.bottom = `${bottom}px`;
    if (cd) cd.style.bottom = `${bottom}px`;
  }

  showButton(seg) {
    if (!this.btn) {
      this.btn = document.createElement("button");
      this.btn.className = "sponsorskip-btn";
      this.player()?.appendChild(this.btn);
      this.btn.addEventListener("click", () => {
        this.video.currentTime = this.activeSeg ? this.activeSeg.end : this.video.currentTime;
        this.hideButton();
      });
    }
    const secs = Math.max(1, Math.round(seg.end - this.video.currentTime));
    this.btn.textContent = `Skip ${seg.category} (${secs}s) ▶`;
    this.btn.style.display = "block";
    this.positionBottomControls();
  }

  hideButton() {
    if (this.btn) this.btn.style.display = "none";
  }

  toast(text) {
    const el = document.createElement("div");
    el.className = "sponsorskip-toast";
    el.textContent = text;
    this.player()?.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  destroy() {
    this.video.removeEventListener("timeupdate", this.onTime);
    this.video.removeEventListener("loadedmetadata", this.onLayout);
    this.video.removeEventListener("durationchange", this.onLayout);
    window.removeEventListener("resize", this.onLayout);
    document.removeEventListener("fullscreenchange", this.onLayout);
    clearInterval(this.bottomTicker);
    this.playerObserver?.disconnect();
    this.playerObserver = null;
    this.markerObserver?.disconnect();
    this.markerObserver = null;
    this.cancelCountdown();
    this.btn?.remove();
    this.btn = null;
    this.markers.forEach((m) => m.remove());
    this.markers = [];
  }
}

// --------------------------------------------------------------------------- //
// Boot + SPA navigation
// --------------------------------------------------------------------------- //
// Popup queries: list this tab's segments, and seek to one.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getSegments") {
    // Return the RAW (all-category) segments; the popup filters them with the
    // user's current category/confidence settings so toggles update instantly.
    sendResponse({
      videoId: currentVideoId,
      segments: lastRawSegments,
      source: lastSource,
      device: lastDevice,
      ms: lastMs,
    });
  } else if (msg?.type === "seek" && typeof msg.time === "number") {
    const v = document.querySelector("video.html5-main-video, video");
    if (v) v.currentTime = msg.time;
    sendResponse({ ok: !!v });
  }
});

async function boot() {
  console.log("[sponsor_skip] content script loaded:", location.href);
  await loadSettings();
  if (location.pathname === "/watch") injectPlayerReader();
}

// YouTube is a SPA: re-run on in-app navigations.
document.addEventListener("yt-navigate-finish", () => {
  if (location.pathname === "/watch") {
    // currentVideoId guard in onVideo prevents duplicate work
    setTimeout(injectPlayerReader, 200);
  } else {
    // left the watch page entirely: tear down and cancel in-flight work
    const previous = currentVideoId;
    currentVideoId = null;
    controller?.destroy();
    controller = null;
    abortInFlight(previous);
    hideStatus();
  }
});

boot();
