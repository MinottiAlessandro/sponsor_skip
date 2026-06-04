const DEFAULTS = {
  mode: "button",
  minConfidence: 0.6,
  autoSkipDelay: 3,
  countdownMode: "grace",
  statusIndicator: "both",
  theme: "auto",
  useSponsorBlock: true,
  detector: "local",
  customModel: "",
  categories: { sponsor: true, selfpromo: true, interaction: false },
  endpoint: "http://localhost:11434/api/generate",
  model: "gemma4:latest",
  maxSegmentSeconds: 300,
};

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };

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
  $("customModel").value = settings.customModel || "";
  $("endpoint").value = settings.endpoint;
  $("model").value = settings.model;
  $("maxSegmentSeconds").value = settings.maxSegmentSeconds;
  $("theme").value = settings.theme;
  syncMode();
  syncDetectorRows();
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

const persist = () => chrome.storage.local.set({ settings });

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
  on("useSponsorBlock", () => { settings.useSponsorBlock = $("useSponsorBlock").checked; persist(); });
  on("detector", () => { settings.detector = $("detector").value; syncDetectorRows(); persist(); });
  on("customModel", () => { settings.customModel = $("customModel").value.trim(); persist(); });
  on("endpoint", () => { settings.endpoint = $("endpoint").value.trim() || DEFAULTS.endpoint; persist(); });
  on("model", () => { settings.model = $("model").value.trim() || DEFAULTS.model; persist(); });
  on("maxSegmentSeconds", () => { settings.maxSegmentSeconds = parseInt($("maxSegmentSeconds").value, 10) || DEFAULTS.maxSegmentSeconds; persist(); });
  on("theme", () => { settings.theme = $("theme").value; persist(); });

  // Live-update the Status panel when a detection finishes or errors while the
  // popup is open (no need to reopen it).
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.lastResult || c.lastError)) renderStatus();
  });

  $("error").addEventListener("click", () => $("error").classList.toggle("open"));
  $("opentest").addEventListener("click", () => window.open(chrome.runtime.getURL("debug/test.html")));
  $("resetcache").addEventListener("click", resetCache);
}

// ---- status panel (segments + error) ------------------------------------ //
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const SOURCE_LABEL = { sponsorblock: "SponsorBlock DB", local: "on-device model", llm: "local LLM" };

async function renderStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let data = null;
  try { data = await chrome.tabs.sendMessage(tab.id, { type: "getSegments" }); } catch { /* no content script */ }
  const { lastError } = await chrome.storage.local.get("lastError");

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
  // Filter the raw (all-category) segments with the user's current settings so
  // toggling a category updates this list instantly.
  const segs = (data.segments || [])
    .filter((s) => settings.categories[s.category] !== false)
    .filter((s) => (s.confidence ?? 1) >= settings.minConfidence)
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (!segs.length) {
    r.className = "muted";
    r.textContent = err.hidden
      ? (data.segments?.length ? "No segments match your enabled categories." : "No sponsor segments detected for this video.")
      : "";
    return;
  }
  r.className = "";
  const via = data.source ? `<div class="via">${segs.length} segment(s) · via <b>${SOURCE_LABEL[data.source] || data.source}</b></div>` : "";
  r.innerHTML = via + segs.map((s, i) =>
    `<div class="seg" data-i="${i}"><span class="dot"></span><span class="cat">${s.category}</span>` +
    `<span class="time">${fmt(s.start)}–${fmt(s.end)}</span></div>`).join("");
  r.querySelectorAll(".seg").forEach((el) =>
    el.addEventListener("click", () =>
      chrome.tabs.sendMessage(tab.id, { type: "seek", time: segs[+el.dataset.i].start })));
}

async function resetCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("seg:") || k.startsWith("src:") || k === "lastResult" || k === "lastError");
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
