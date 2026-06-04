// In-browser sponsor detector: runs the fine-tuned token classifier over the
// transcript via Transformers.js (ONNX Runtime Web). No server — this replaces the
// Ollama LLM call. Used from the offscreen document and verified in Node.
//
// Mapping trick: we tokenize each cue separately and concatenate the ids ([CLS] +
// cue0 + cue1 + ... + [SEP]), so we know exactly which tokens belong to which cue
// without needing char offsets. A cue is "sponsor" if enough of its tokens are
// predicted sponsor; contiguous sponsor cues become a segment with the cues'
// absolute timestamps. Result is then gap-merged and over-skip-guarded — the same
// post-processing the eval uses.

const MAX_LEN = 384;
const SPONSOR_CLASS = 1; // label order: 0=O, 1=sponsor, 2=selfpromo, 3=interaction

export function cueWindows(n, size, overlap) {
  const step = Math.max(1, size - overlap);
  const out = [];
  for (let s = 0; s < n; s += step) {
    out.push([s, Math.min(n, s + size)]);
    if (s + size >= n) break;
  }
  return out;
}

function mkSeg(cues, a, b) {
  return {
    start: cues[a].start,
    end: cues[b].start + (cues[b].duration || 0),
    category: "sponsor",
    confidence: 0.8,
  };
}

export function mergeSegments(segs, gap = 5) {
  if (!segs.length) return [];
  const s = [...segs].sort((x, y) => x.start - y.start);
  const out = [s[0]];
  for (let i = 1; i < s.length; i++) {
    const last = out[out.length - 1];
    if (s[i].start - last.end <= gap) last.end = Math.max(last.end, s[i].end);
    else out.push(s[i]);
  }
  return out;
}

export function dropLongSegments(segs, maxSeconds) {
  return segs.filter((s) => s.end - s.start <= maxSeconds);
}

// Moving-average smoothing over ±radius cues (kills single-cue flicker).
function smoothProbs(p, radius) {
  if (radius <= 0) return p;
  const out = new Array(p.length);
  for (let i = 0; i < p.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(p.length - 1, i + radius); j++) {
      sum += p[j]; n++;
    }
    out[i] = sum / n;
  }
  return out;
}

export async function detectLocal(cues, { tokenizer, model, Tensor }, opts = {}) {
  const {
    windowCues = 60, overlap = 12,
    // Hysteresis: enter a sponsor only when confident (enter), but stay in it
    // through brief dips until clearly out (exit) — stops one read splitting in two.
    // enter is precision-leaning (over-skip is the cardinal sin); exit is low enough
    // to bridge chatty dips inside a read.
    enterThreshold = 0.8,
    exitThreshold = 0.5,
    smoothRadius = 0,            // moving-average ±cues; 0 = off (smoothing smears edges)
    minSegmentSeconds = 5,       // drop specks (false-positive noise)
    mergeGap = 15,               // bridge any residual holes between fragments
    maxSegmentSeconds = 300,
  } = opts;
  if (!cues || !cues.length) return [];

  // [CLS] / [SEP] ids for this tokenizer (encode("") -> just the special pair).
  const special = tokenizer.encode("");
  const clsId = special[0];
  const sepId = special[special.length - 1];

  // Per-cue P(sponsor), averaged across the (overlapping) windows that cover it.
  const probSum = new Array(cues.length).fill(0);
  const probCnt = new Array(cues.length).fill(0);
  for (const [a, b] of cueWindows(cues.length, windowCues, overlap)) {
    const ids = [clsId];
    const spans = []; // [cueIndex, tokStart, tokEnd) within ids
    for (let i = a; i < b; i++) {
      const enc = tokenizer.encode(cues[i].text || "", { add_special_tokens: false });
      const start = ids.length;
      for (const id of enc) {
        if (ids.length < MAX_LEN - 1) ids.push(id);
      }
      spans.push([i, start, ids.length]);
      if (ids.length >= MAX_LEN - 1) break;
    }
    ids.push(sepId);

    const input = new Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
    const mask = new Tensor("int64", BigInt64Array.from(ids.map(() => 1n)), [1, ids.length]);
    const { logits } = await model({ input_ids: input, attention_mask: mask });
    const nlab = logits.dims[2];
    const d = logits.data;
    // P(sponsor) for token t = softmax over ALL classes at the SPONSOR index.
    // (The model is multi-class: O / sponsor / selfpromo / interaction.)
    const pSponsor = (t) => {
      const o = t * nlab;
      let mx = -Infinity;
      for (let c = 0; c < nlab; c++) if (d[o + c] > mx) mx = d[o + c];
      let sum = 0;
      for (let c = 0; c < nlab; c++) sum += Math.exp(d[o + c] - mx);
      return Math.exp(d[o + SPONSOR_CLASS] - mx) / sum;
    };

    for (const [ci, ts, te] of spans) {
      if (te <= ts) continue;
      let sum = 0;
      for (let t = ts; t < te; t++) sum += pSponsor(t);
      probSum[ci] += sum / (te - ts);
      probCnt[ci] += 1;
    }
    // Yield to the event loop between windows so we don't hog the shared
    // extension renderer thread — keeps the popup responsive during analysis.
    await new Promise((r) => setTimeout(r));
  }

  const prob = probSum.map((s, i) => (probCnt[i] ? s / probCnt[i] : 0));
  const sm = smoothProbs(prob, smoothRadius);

  // Hysteresis scan -> contiguous sponsor runs.
  const segs = [];
  let s = null;
  for (let i = 0; i < cues.length; i++) {
    if (s === null && sm[i] >= enterThreshold) s = i;
    else if (s !== null && sm[i] < exitThreshold) { segs.push(mkSeg(cues, s, i - 1)); s = null; }
  }
  if (s !== null) segs.push(mkSeg(cues, s, cues.length - 1));

  const merged = mergeSegments(segs, mergeGap);
  const kept = merged.filter((g) => g.end - g.start >= minSegmentSeconds);
  return dropLongSegments(kept, maxSegmentSeconds);
}
