// Debug harness: feed the on-device model a transcript and show what it detects.
// Talks to the background worker (type:"localDetectTest"), which runs the exact
// production offscreen path.

const SAMPLE = [
  [0, "hey everyone welcome back to the channel"],
  [4, "today we are going to build something really fun together"],
  [8, "but first i want to tell you about todays sponsor"],
  [12, "this video is sponsored by NordVPN"],
  [16, "NordVPN keeps your browsing private and secure on any network"],
  [20, "use my code TEST at nordvpn dot com to get a huge discount today"],
  [24, "it works on all your devices with a thirty day money back guarantee"],
  [28, "so go check them out using the link in the description below"],
  [32, "okay now lets get back to the actual project"],
  [36, "the first step is to set up our development environment"],
  [40, "then we will write the core logic piece by piece"],
].map(([start, text]) => `${start} | ${text}`).join("\n");

const $ = (id) => document.getElementById(id);
$("cues").value = SAMPLE;

function parseCues(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("|");
      const start = parseFloat(l.slice(0, i));
      return { text: l.slice(i + 1).trim(), start, duration: 4 };
    })
    .filter((c) => !Number.isNaN(c.start));
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

$("run").addEventListener("click", async () => {
  const cues = parseCues($("cues").value);
  $("spin").textContent = "running (first run loads the model — a few seconds)…";
  $("out").className = "muted";
  $("out").textContent = "";
  try {
    const r = await chrome.runtime.sendMessage({ type: "localDetectTest", cues });
    $("spin").textContent = "";
    if (!r?.ok) {
      $("out").className = "err";
      $("out").textContent = "ERROR:\n" + (r?.error || "no response");
      return;
    }
    $("out").className = "ok";
    const lines = (r.segments || []).map(
      (s) => `  ${fmt(s.start)} – ${fmt(s.end)}   (${s.category}, conf ${s.confidence})`
    );
    $("out").textContent =
      `✓ detection ran in ${r.ms} ms\n${cues.length} cues → ${r.segments.length} segment(s):\n` +
      (lines.join("\n") || "  (none)");
  } catch (err) {
    $("spin").textContent = "";
    $("out").className = "err";
    $("out").textContent = "ERROR:\n" + String(err);
  }
});
