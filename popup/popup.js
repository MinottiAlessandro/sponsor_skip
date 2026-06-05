// DEFAULTS and filterSegments come from ../src/defaults.js (loaded just before this
// script), shared with the content script so both filter segments identically.
const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let popupVideoId = null; // the video the active tab is currently on (for submit/dismiss)

// ---- tabs ---------------------------------------------------------------- //
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll(".panel").forEach((p) =>
      p.classList.toggle("active", p.dataset.panel === t.dataset.tab)
    );
  })
);

// ---- settings <-> controls ---------------------------------------------- //
function applyControls() {
  $("mode2").value = settings.mode;
  $("autoSkipDelay").value = settings.autoSkipDelay;
  $("countdownMode").value = settings.countdownMode;
  $("minConfidence").value = settings.minConfidence;
  $("statusIndicator").value = settings.statusIndicator;
  $("cat_sponsor").checked = settings.categories.sponsor;
  $("cat_selfpromo").checked = settings.categories.selfpromo;
  $("cat_interaction").checked = settings.categories.interaction;
  $("useSponsorBlock").checked = settings.useSponsorBlock;
  $("detector").value = settings.detector;
  $("device").value = settings.device;
  $("customModel").value = settings.customModel || "";
  $("endpoint").value = settings.endpoint;
  $("model").value = settings.model;
  $("maxSegmentSeconds").value = settings.maxSegmentSeconds;
  $("theme").value = settings.theme;
  syncMode();
  syncDetectorRows();
  syncCategoryRows();
}

function syncMode() {
  document.querySelectorAll(".modes .m").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === settings.mode)
  );
  $("mode2").value = settings.mode;
}
function syncDetectorRows() {
  const ollama = settings.detector === "ollama";
  $("ollamaRow").style.display = ollama ? "" : "none";
  $("localRow").style.display = ollama ? "none" : "";
}
// The on-device model emits sponsor segments only — self-promo & interaction come
// solely from SponsorBlock. Grey those two out when SponsorBlock is turned off.
function syncCategoryRows() {
  const sbOff = !settings.useSponsorBlock;
  for (const c of ["selfpromo", "interaction"]) {
    const box = $("cat_" + c);
    box.disabled = sbOff;
    box.closest(".check").classList.toggle("disabled", sbOff);
  }
}

const persist = () => chrome.storage.local.set({ settings });

// Optional host permissions (declared in the manifest) are requested lazily — only
// when the user opts into a feature that needs them, and from a click/change
// handler so Chrome accepts the request as a user gesture.
const HF_HOSTS = ["https://huggingface.co/*", "https://*.hf.co/*"];
function neededOptionalOrigins() {
  const out = [];
  if (settings.detector === "ollama") {
    try { out.push(new URL(settings.endpoint).origin + "/*"); } catch { /* bad URL */ }
  }
  const cm = (settings.customModel || "").trim();
  if (cm) {
    out.push(...HF_HOSTS);
    if (/^https?:\/\//i.test(cm)) { try { out.push(new URL(cm).origin + "/*"); } catch { /* not a URL */ } }
  }
  return out;
}
function ensureOptionalPermissions() {
  const origins = neededOptionalOrigins();
  if (!origins.length) return Promise.resolve(true);
  return new Promise((resolve) =>
    chrome.permissions.request({ origins }, (granted) => resolve(!!granted))
  );
}

function setMode(m) {
  settings.mode = m;
  syncMode();
  persist();
}

function bind() {
  document.querySelectorAll(".modes .m").forEach((b) =>
    b.addEventListener("click", () => setMode(b.dataset.mode))
  );
  $("mode2").addEventListener("change", () => setMode($("mode2").value));

  const on = (id, fn, ev = "change") => $(id).addEventListener(ev, fn);
  on("autoSkipDelay", () => { settings.autoSkipDelay = parseInt($("autoSkipDelay").value, 10) || 0; persist(); });
  on("countdownMode", () => { settings.countdownMode = $("countdownMode").value; persist(); });
  on("minConfidence", () => { settings.minConfidence = parseFloat($("minConfidence").value) || 0; persist(); renderStatus(); });
  on("statusIndicator", () => { settings.statusIndicator = $("statusIndicator").value; persist(); });
  ["sponsor", "selfpromo", "interaction"].forEach((c) =>
    on("cat_" + c, () => { settings.categories[c] = $("cat_" + c).checked; persist(); renderStatus(); })
  );
  on("useSponsorBlock", () => { settings.useSponsorBlock = $("useSponsorBlock").checked; persist(); syncCategoryRows(); });
  on("detector", async () => {
    settings.detector = $("detector").value; syncDetectorRows(); persist();
    if (settings.detector === "ollama" && !(await ensureOptionalPermissions())) {
      settings.detector = "local"; $("detector").value = "local"; syncDetectorRows(); persist();
      toast("Ollama needs local-network access — not granted");
    }
  });
  on("customModel", async () => {
    settings.customModel = $("customModel").value.trim(); persist();
    if (settings.customModel && !(await ensureOptionalPermissions())) {
      toast("Custom models need Hugging Face access — not granted");
    }
  });
  on("device", () => { settings.device = $("device").value; persist(); });
  on("endpoint", async () => {
    settings.endpoint = $("endpoint").value.trim() || DEFAULTS.endpoint; persist();
    if (settings.detector === "ollama") await ensureOptionalPermissions();
  });
  on("model", () => { settings.model = $("model").value.trim() || DEFAULTS.model; persist(); });
  on("maxSegmentSeconds", () => { settings.maxSegmentSeconds = parseInt($("maxSegmentSeconds").value, 10) || DEFAULTS.maxSegmentSeconds; persist(); });
  on("theme", () => { settings.theme = $("theme").value; persist(); });

  // Live-update the Status panel when a detection finishes or errors while the
  // popup is open (no need to reopen it).
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.lastResult || c.lastError)) renderStatus();
  });

  $("error").addEventListener("click", () => $("error").classList.toggle("open"));
  $("cCancel").addEventListener("click", cancelSubmit);
  $("cSubmit").addEventListener("click", submitPending);
  $("opentest").addEventListener("click", () => window.open(chrome.runtime.getURL("debug/test.html")));
  $("resetcache").addEventListener("click", resetCache);
}

// ---- status panel (segments + error) ------------------------------------ //
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const SOURCE_LABEL = { sponsorblock: "SponsorBlock DB", local: "on-device model", llm: "local LLM" };
const DEVICE_LABEL = { wasm: "CPU", webgpu: "GPU" }; // backend the on-device model used

async function renderStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let data = null;
  try { data = await chrome.tabs.sendMessage(tab.id, { type: "getSegments" }); } catch { /* no content script */ }
  const { lastResult, lastError } = await chrome.storage.local.get(["lastResult", "lastError"]);

  // error banner (only for the video currently open)
  const err = $("error");
  if (lastError && data && lastError.videoId === data.videoId) {
    $("ereason").textContent = lastError.reason || "Unknown error.";
    err.hidden = false;
  } else {
    err.hidden = true;
  }

  const r = $("result");
  if (!data) { r.className = "muted"; r.textContent = "Open a YouTube video to detect sponsors."; return; }

  if (popupVideoId !== data.videoId) cancelSubmit(); // close a stale confirm on video change
  popupVideoId = data.videoId;

  // A just-finished detection writes lastResult to storage (which wakes this popup)
  // a beat BEFORE the content script has received the same result — so mid-handoff
  // the content script still reports empty. When lastResult is for the video the
  // active tab is on, render from it directly: that way a sponsor found while the
  // popup is open shows up immediately instead of only after a close/reopen. The
  // videoId match keeps a background tab's detection from leaking into this one.
  const result = lastResult && lastResult.videoId === data.videoId ? lastResult : data;

  // Filter the raw (all-category) segments with the user's current settings (shared
  // with the content script) so toggling a category updates this list instantly.
  const segs = filterSegments(result.segments || [], settings);
  if (!segs.length) {
    r.className = "muted";
    r.textContent = err.hidden
      ? (result.segments?.length ? "No segments match your enabled categories." : "No sponsor segments detected for this video.")
      : "";
    return;
  }
  r.className = "";
  const srcLabel = SOURCE_LABEL[result.source] || result.source;
  // Only the on-device model has a backend + timing; show whichever actually ran
  // (after any fallback) and how long inference took.
  const bits = [];
  if (result.source === "local") {
    if (result.device) bits.push(DEVICE_LABEL[result.device] || result.device);
    if (result.ms != null) bits.push(fmtMs(result.ms));
  }
  const devChip = bits.length ? ` <span class="dev">${bits.join(" · ")}</span>` : "";
  const via = result.source ? `<div class="via">${segs.length} segment(s) · via <b>${srcLabel}</b>${devChip}</div>` : "";
  r.innerHTML = via + segs.map((s, i) => `<div class="seg" data-i="${i}">${voteCell(s)}` +
    `<span class="cat">${s.category}</span>` +
    `<span class="time">${fmt(s.start)}–${fmt(s.end)}</span></div>`).join("");
  // Clicking the row (but not a vote button) seeks the video to the segment start.
  r.querySelectorAll(".seg").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest(".vote")) return;
      chrome.tabs.sendMessage(tab.id, { type: "seek", time: segs[+el.dataset.i].start });
    }));
  r.querySelectorAll(".vote").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const seg = segs[+btn.closest(".seg").dataset.i];
      const up = btn.classList.contains("up");
      if (seg.uuid) castVote(seg, up ? 1 : 0, btn); // SponsorBlock segment → vote
      else if (up) startSubmit(seg);                // model segment → contribute it
      else dismissSegment(seg);                     // model segment → false positive
    }));
}

// Each row gets thumbs on the left, but they mean different things by source:
//   • SponsorBlock segment (has uuid) → up/down VOTE (Phase 1)
//   • model segment (no uuid)         → 👍 contribute to SponsorBlock / 👎 dismiss (Phase 3)
// A contributed segment gains a uuid + a ✓ badge and becomes voteable like any other.
const castVotes = new Map(); // uuid -> 1 (up) | 0 (down), to keep highlight across re-renders
const sharedBadge = `<span class="shared" title="On SponsorBlock">✓</span>`;
const thumb = (dir, title, cast) =>
  `<button class="vote ${dir}${cast ? " cast" : ""}" title="${title}">${dir === "up" ? "👍" : "👎"}</button>`;
function voteCell(s) {
  if (s.uuid) {
    const v = castVotes.get(s.uuid);
    return `<span class="votes">${s.contributed ? sharedBadge : ""}` +
      thumb("up", "Upvote on SponsorBlock", v === 1) +
      thumb("down", "Downvote on SponsorBlock", v === 0) + `</span>`;
  }
  if (s.contributed) return `<span class="votes">${sharedBadge}</span>`; // submitted, no uuid back
  return `<span class="votes">` +
    thumb("up", "Accurate — add to SponsorBlock", false) +
    thumb("down", "Wrong — remove (won't skip)", false) + `</span>`;
}

async function castVote(seg, type, btn) {
  if (!seg?.uuid) return;
  const group = btn.closest(".votes");
  group.querySelectorAll(".vote").forEach((b) => (b.disabled = true));
  try {
    const r = await chrome.runtime.sendMessage({ type: "sbVote", uuid: seg.uuid, voteType: type });
    if (!r?.ok) throw new Error(r?.error || "vote failed");
    castVotes.set(seg.uuid, type);
    group.querySelectorAll(".vote").forEach((b) => b.classList.remove("cast"));
    btn.classList.add("cast");
    toast(type ? "Upvoted on SponsorBlock — thanks!" : "Downvoted on SponsorBlock");
  } catch (err) {
    toast(`Vote failed: ${String(err.message || err)}`);
  } finally {
    group.querySelectorAll(".vote").forEach((b) => (b.disabled = false));
  }
}

// ---- contribute a model segment to SponsorBlock (Phase 3) ---------------- //
// Human-in-the-loop: 👍 opens a confirm (reminding the user to fix boundaries on the
// video first); only an explicit Submit posts it to the public DB.
let pendingSubmit = null;
function startSubmit(seg) {
  pendingSubmit = { start: seg.start, end: seg.end, category: seg.category || "sponsor" };
  $("cbody").textContent = `Sponsor · ${fmt(seg.start)} – ${fmt(seg.end)}`;
  $("submitConfirm").hidden = false;
}
function cancelSubmit() {
  pendingSubmit = null;
  $("submitConfirm").hidden = true;
}
async function submitPending() {
  if (!pendingSubmit || !popupVideoId) return;
  const seg = pendingSubmit;
  const sub = $("cSubmit"), cancel = $("cCancel");
  sub.disabled = cancel.disabled = true;
  sub.textContent = "Submitting…";
  try {
    const r = await chrome.runtime.sendMessage({ type: "sbSubmit", videoId: popupVideoId, segment: seg });
    if (!r?.ok) throw new Error(r?.error || "submit failed");
    // Tag it locally so it shows as contributed (and becomes voteable). The server
    // already has it even if the content script is somehow unreachable.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: "tagContributed", start: seg.start, uuid: r.uuid });
    } catch { /* content script gone — fine */ }
    toast("Added to SponsorBlock — thanks! 🎉");
    cancelSubmit();
    renderStatus();
  } catch (err) {
    toast(`Submit failed: ${String(err.message || err)}`);
  } finally {
    sub.disabled = cancel.disabled = false;
    sub.textContent = "Submit";
  }
}

// 👎 on a model segment: drop it from skipping (locally + persisted) as a false positive.
async function dismissSegment(seg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: "dismissSegment", start: seg.start });
    toast("Removed — won't skip this");
    renderStatus();
  } catch {
    toast("Couldn't remove that segment");
  }
}

async function resetCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("seg:") || k.startsWith("src:") || k.startsWith("dev:") || k === "lastResult" || k === "lastError");
  await chrome.storage.local.remove(keys);
  toast(`Cleared ${keys.filter((k) => k.startsWith("seg:")).length} cached video(s)`);
  renderStatus();
}

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 1800);
}

// ---- boot ---------------------------------------------------------------- //
// Bind the UI synchronously so the popup is interactive immediately — even while a
// video is being analyzed (the offscreen model shares this extension's renderer
// thread, so we must not gate interactivity behind any async/message round-trip).
bind();
(async () => {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULTS, ...(stored.settings || {}), categories: { ...DEFAULTS.categories, ...(stored.settings?.categories || {}) } };
  applyControls();
  renderStatus();
  fetch(chrome.runtime.getURL("model/model_version.json"))
    .then((r) => r.json())
    .then((m) => { $("modelinfo").textContent = `model v${m.version}`; })
    .catch(() => { $("modelinfo").textContent = ""; });
})();
