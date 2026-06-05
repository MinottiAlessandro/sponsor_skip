// Applies the saved theme (auto/light/dark) to the document. Used by the popup.
// "auto" resolves against the OS preference; we set a concrete data-theme so the
// CSS only needs [data-theme="dark"] rules.
function resolveDark(theme) {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches; // auto
}

async function applyTheme() {
  const { settings } = await chrome.storage.local.get("settings");
  const theme = settings?.theme || "auto";
  document.documentElement.dataset.theme = resolveDark(theme) ? "dark" : "light";
}

// Re-apply when the OS preference flips (matters while on "auto") or settings change.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) applyTheme();
});

applyTheme();
