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
    if (t.dataset.tab === "detector") renderModels();
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
  $("language").value = settings.language;
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

// Fill every translatable node from the current language. Static text uses
// data-i18n; attributes use data-i18n-title / -placeholder / -aria. Re-run after a
// language change to retranslate the open popup in place.
function applyI18n() {
  document.documentElement.lang = I18N.lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
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
      toast(t("ollama_not_granted"));
    }
  });
  on("customModel", async () => {
    settings.customModel = $("customModel").value.trim(); persist();
    if (settings.customModel && !(await ensureOptionalPermissions())) {
      toast(t("custom_not_granted"));
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
  on("language", () => {
    settings.language = $("language").value; persist();
    I18N.setLang(settings.language);
    applyI18n();    // retranslate the static UI in place…
    renderStatus(); // …and the dynamic panels (status list, model labels)
    renderModels();
  });

  // Live-update the Status panel when a detection finishes or errors while the
  // popup is open (no need to reopen it).
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.lastResult || c.lastError)) renderStatus();
  });

  $("error").addEventListener("click", () => $("error").classList.toggle("open"));
  $("addSeg").addEventListener("click", addSegmentAtPlayhead);
  $("cCancel").addEventListener("click", cancelSubmit);
  $("cSubmit").addEventListener("click", submitPending);
  $("refreshModels").addEventListener("click", refreshModelsUI);
  $("modelList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === "use") useModel(id);
    else if (action === "download") downloadModelUI(id);
    else if (action === "delete") deleteModelUI(id);
    else if (action === "dismissNotice") chrome.storage.local.remove("modelNotice").then(renderModels);
  });
  // Live download progress from the background/offscreen worker.
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === "downloadProgress") updateProgressBar(m.pct);
    else if (m?.type === "downloadStateChanged") renderModels();
  });
  $("opentest").addEventListener("click", () => window.open(chrome.runtime.getURL("debug/test.html")));
  $("resetcache").addEventListener("click", resetCache);
}

// ---- status panel (segments + error) ------------------------------------ //
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
// Localized labels (keys resolved through i18n.js at call time, so they follow the
// current language without rebuilding these maps).
const SRC_KEY = { sponsorblock: "src_sponsorblock", local: "src_local", llm: "src_llm" };
const DEV_KEY = { wasm: "dev_wasm", webgpu: "dev_webgpu" }; // backend the on-device model used
const CAT_KEY = { sponsor: "catname_sponsor", selfpromo: "catname_selfpromo", interaction: "catname_interaction" };
const sourceLabel = (s) => (SRC_KEY[s] ? t(SRC_KEY[s]) : s);
const deviceLabel = (d) => (DEV_KEY[d] ? t(DEV_KEY[d]) : d);
const categoryLabel = (c) => (CAT_KEY[c] ? t(CAT_KEY[c]) : c);

async function renderStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let data = null;
  try { data = await chrome.tabs.sendMessage(tab.id, { type: "getSegments" }); } catch { /* no content script */ }
  const { lastResult, lastError } = await chrome.storage.local.get(["lastResult", "lastError"]);

  // error banner (only for the video currently open)
  const err = $("error");
  if (lastError && data && lastError.videoId === data.videoId) {
    $("ereason").textContent = lastError.reason || t("err_unknown");
    err.hidden = false;
  } else {
    err.hidden = true;
  }

  const r = $("result");
  if (!data) {
    r.className = "muted"; r.textContent = t("result_open");
    $("addSegRow").hidden = true;
    return;
  }

  if (popupVideoId !== data.videoId) cancelSubmit(); // close a stale confirm on video change
  popupVideoId = data.videoId;
  $("addSegRow").hidden = false; // a video is open → allow manual segment adding

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

  // Analysis meta (source + backend + time) — built once and shown whether or not any
  // sponsors were found, so the user can always see that (and how) the video was analyzed.
  const srcLabel = sourceLabel(result.source);
  // Only the on-device model has a backend + timing; show whichever actually ran
  // (after any fallback) and how long inference took.
  const bits = [];
  if (result.source === "local") {
    if (result.device) bits.push(deviceLabel(result.device));
    if (result.ms != null) bits.push(fmtMs(result.ms));
  }
  const devChip = bits.length ? ` <span class="dev">${bits.join(" · ")}</span>` : "";

  if (!segs.length) {
    if (!err.hidden) { r.className = "muted"; r.textContent = ""; return; } // error banner says it
    const msg = result.segments?.length ? t("no_match") : t("no_sponsors");
    // Still surface that the video WAS analyzed (and how), when we have that info.
    if (result.source) {
      r.className = "";
      r.innerHTML = `<div class="via">${msg} · ${t("via")} <b>${srcLabel}</b>${devChip}</div>`;
    } else {
      r.className = "muted";
      r.textContent = msg;
    }
    return;
  }

  r.className = "";
  const via = result.source ? `<div class="via">${tn(segs.length, "seg_count_one", "seg_count_many")} · ${t("via")} <b>${srcLabel}</b>${devChip}</div>` : "";
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
// uuid -> 1 (up) | 0 (down). Hydrated from storage on boot and persisted on each
// vote, so the highlight survives not just re-renders but a popup close/reopen
// (the popup's JS context — and this Map — is rebuilt every time it opens).
const castVotes = new Map();
const persistVotes = () =>
  chrome.storage.local.set({ sbVotes: Object.fromEntries(castVotes) }).catch(() => {});
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
    persistVotes();
    group.querySelectorAll(".vote").forEach((b) => b.classList.remove("cast"));
    btn.classList.add("cast");
    toast(type ? t("vote_up_ok") : t("vote_down_ok"));
  } catch (err) {
    toast(t("vote_failed", { err: String(err.message || err) }));
  } finally {
    group.querySelectorAll(".vote").forEach((b) => (b.disabled = false));
  }
}

// ---- contribute a model segment to SponsorBlock (Phase 3) ---------------- //
// Human-in-the-loop: 👍 opens a confirm (reminding the user to fix boundaries on the
// video first); only an explicit Submit posts it to the public DB.
let pendingSubmit = null;
function startSubmit(seg) {
  const cat = seg.category || "sponsor";
  pendingSubmit = { start: seg.start, end: seg.end, category: cat };
  $("cbody").textContent = `${categoryLabel(cat)} · ${fmt(seg.start)} – ${fmt(seg.end)}`;
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
  sub.textContent = t("submitting");
  try {
    const r = await chrome.runtime.sendMessage({ type: "sbSubmit", videoId: popupVideoId, segment: seg });
    if (!r?.ok) throw new Error(r?.error || "submit failed");
    // Tag it locally so it shows as contributed (and becomes voteable). The server
    // already has it even if the content script is somehow unreachable.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { type: "tagContributed", start: seg.start, uuid: r.uuid });
    } catch { /* content script gone — fine */ }
    toast(t("submit_ok"));
    cancelSubmit();
    renderStatus();
  } catch (err) {
    toast(t("submit_failed", { err: String(err.message || err) }));
  } finally {
    sub.disabled = cancel.disabled = false;
    sub.textContent = t("btn_submit");
  }
}

// 👎 on a model segment: drop it from skipping (locally + persisted) as a false positive.
async function dismissSegment(seg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { type: "dismissSegment", start: seg.start });
    toast(t("removed"));
    renderStatus();
  } catch {
    toast(t("remove_failed"));
  }
}

// Manually add a sponsor segment at the current playhead; the user then drags its
// edges on the video to set the exact bounds (and can 👍 it to SponsorBlock or 👎 it).
async function addSegmentAtPlayhead() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const category = $("addSegCat")?.value || "sponsor";
    const r = await chrome.tabs.sendMessage(tab.id, { type: "addSegment", category });
    if (!r?.ok) throw new Error(r?.error || "couldn't add");
    toast(t("seg_added", { cat: categoryLabel(category) }));
    renderStatus();
  } catch {
    toast(t("seg_add_failed"));
  }
}

// ---- model manager (Detector tab) --------------------------------------- //
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function requestHF() {
  return new Promise((res) => chrome.permissions.request({ origins: HF_HOSTS }, (g) => res(!!g)));
}

async function renderModels() {
  const list = $("modelList");
  if (!list) return;
  let data;
  try { data = await chrome.runtime.sendMessage({ type: "getModels" }); } catch { return; }
  const models = data?.models || [];
  const dl = data?.downloadState || null;
  const langs = (ls) => (ls || []).map((l) => l.toUpperCase()).join(" ");
  const notice = data?.modelNotice
    ? `<div class="mnotice">⚠ ${escapeHtml(data.modelNotice)}<button data-action="dismissNotice" title="${t("m_dismiss")}">✕</button></div>`
    : "";
  list.innerHTML = notice + models.map((m) => {
    const downloading = dl && dl.id === m.id && dl.status === "downloading";
    const meta = [m.sizeMB ? `${m.sizeMB} MB` : "", langs(m.languages)].filter(Boolean).join(" · ");
    const upd = m.updateAvailable ? `<button class="btn sm" data-action="download" data-id="${m.id}">${t("m_update")}</button>` : "";
    let ctl;
    if (downloading) {
      ctl = `<div class="mprog"><div class="mbar" style="width:${dl.pct || 0}%"></div></div><span class="mpct">${dl.pct || 0}%</span>`;
    } else if (m.active) {
      ctl = `<span class="mactive">${t("m_active")}</span>${upd}`;
    } else if (m.downloaded) {
      ctl = `<button class="btn sm accent" data-action="use" data-id="${m.id}">${t("m_use")}</button>${upd}` +
        (m.builtin ? "" : `<button class="btn sm" data-action="delete" data-id="${m.id}">${t("m_delete")}</button>`);
    } else {
      ctl = `<button class="btn sm" data-action="download" data-id="${m.id}">${t("m_download")}${m.sizeMB ? ` (${m.sizeMB} MB)` : ""}</button>`;
    }
    const rec = m.recommended ? `<span class="mbadge">${t("m_recommended")}</span>` : "";
    return `<div class="model${m.active ? " on" : ""}" data-id="${m.id}">` +
      `<div class="minfo"><div class="mname">${escapeHtml(m.name)}${rec}</div><div class="mmeta">${escapeHtml(meta)}</div></div>` +
      `<div class="mctl">${ctl}</div></div>`;
  }).join("") || `<div class="hint">${t("m_none")}</div>`;
  const totalMB = models.filter((m) => m.downloaded && !m.builtin).reduce((s, m) => s + (m.sizeMB || 0), 0);
  $("storageUsed").textContent = totalMB ? t("storage_used", { mb: totalMB }) : "";
}

function updateProgressBar(pct) {
  const bar = $("modelList")?.querySelector(".mprog .mbar");
  const lbl = $("modelList")?.querySelector(".mpct");
  if (bar) bar.style.width = `${pct}%`;
  if (lbl) lbl.textContent = `${pct}%`;
}

async function useModel(id) {
  settings.modelId = id;
  await persist();
  toast(t("model_selected"));
  renderModels();
}

async function downloadModelUI(id) {
  if (!(await requestHF())) { toast(t("hf_not_granted")); return; }
  chrome.runtime.sendMessage({ type: "downloadModel", id })
    .then((r) => { toast(r?.ok ? t("model_downloaded") : t("download_failed", { err: r?.error || "" })); renderModels(); })
    .catch(() => {});
  setTimeout(renderModels, 60); // pick up the "downloading" state the background just set
}

async function deleteModelUI(id) {
  try {
    const r = await chrome.runtime.sendMessage({ type: "deleteModel", id });
    if (!r?.ok) throw new Error(r?.error || "delete failed");
    // If we somehow deleted the active model, fall back to the default.
    if (settings.modelId === id) { settings.modelId = "default"; await persist(); }
    toast(t("model_deleted"));
  } catch (err) { toast(t("delete_failed", { err: String(err.message || err) })); }
  renderModels();
}

async function refreshModelsUI() {
  if (!(await requestHF())) { toast(t("hf_not_granted")); return; }
  $("refreshModels").disabled = true;
  try { await chrome.runtime.sendMessage({ type: "refreshCatalog" }); } catch {}
  $("refreshModels").disabled = false;
  renderModels();
}

async function resetCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("seg:") || k.startsWith("src:") || k.startsWith("dev:") || k === "lastResult" || k === "lastError");
  await chrome.storage.local.remove(keys);
  toast(tn(keys.filter((k) => k.startsWith("seg:")).length, "cache_cleared_one", "cache_cleared_many"));
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
  const stored = await chrome.storage.local.get(["settings", "sbVotes"]);
  settings = { ...DEFAULTS, ...(stored.settings || {}), categories: { ...DEFAULTS.categories, ...(stored.settings?.categories || {}) } };
  for (const [uuid, type] of Object.entries(stored.sbVotes || {})) castVotes.set(uuid, type);
  I18N.setLang(settings.language);
  applyI18n();
  applyControls();
  renderStatus();
  renderModels();
  fetch(chrome.runtime.getURL("model/model_version.json"))
    .then((r) => r.json())
    .then((m) => { $("modelinfo").textContent = t("model_version", { v: m.version }); })
    .catch(() => { $("modelinfo").textContent = ""; });
})();
