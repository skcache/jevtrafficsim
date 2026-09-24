/**
 * Display-rate jitter analysis.
 *
 * Input: per-animation-frame samples captured by the ?debug probe.
 * The thing the user sees is the RENDERED step per animation frame, so that is
 * what this measures - not frame arrivals, which are only the cause.
 */
import { readFileSync } from "node:fs";

type Sample = {
  t: number;
  x: number;
  y: number;
  h: number;
  road: number | null;
  progress: number | null;
  receivedAtMs?: number;
  alpha?: number;
  cameraCenter?: [number, number] | null;
  cameraZoom?: number | null;
};

const all = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/ship-qa/raf-samples.json", "utf8")) as Sample[];
// Only steady same-road driving: junction frames legitimately change direction.
const frames: Sample[] = [];
for (let i = 1; i < all.length; i += 1) {
  if (all[i].road !== null && all[i].road === all[i - 1].road) frames.push(all[i]);
}

// Frame arrivals: gaps between distinct receivedAtMs values.
const arrivals: number[] = [];
const seen = new Set<number>();
for (const f of all) {
  if (f.receivedAtMs && !seen.has(f.receivedAtMs)) {
    seen.add(f.receivedAtMs);
    arrivals.push(f.receivedAtMs);
  }
}
const arrivalGaps: number[] = [];
for (let i = 1; i < arrivals.length; i += 1) arrivalGaps.push(arrivals[i] - arrivals[i - 1]);
arrivalGaps.sort((a, b) => a - b);
const pct = (arr: number[], p: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN);
const mean = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN);

// The rendered step per animation frame - the jitter the user reports.
const steps: number[] = [];
const dts: number[] = [];
for (let i = 1; i < frames.length; i += 1) {
  const a = frames[i - 1];
  const b = frames[i];
  const moved = Math.hypot(b.x - a.x, b.y - a.y);
  const dt = b.t - a.t;
  if (dt > 0 && dt < 100 && moved < 40) {
    steps.push(moved);
    dts.push(dt);
  }
}
const meanStep = mean(steps);
const speed = meanStep / (mean(dts) / 1000); // m/s of rendered motion
let variance = 0;
let freezes = 0;
let spikes = 0;
for (let i = 0; i < steps.length; i += 1) {
  variance += (steps[i] - meanStep) ** 2;
  const ratio = steps[i] / meanStep;
  if (ratio < 0.4) freezes += 1; // the car visibly stalls
  if (ratio > 1.8) spikes += 1; // then jumps
}
const stdDev = Math.sqrt(variance / Math.max(1, steps.length));

// Camera motion per animation frame, in degrees (converted to metres at zooms).
const camSteps: number[] = [];
for (let i = 1; i < frames.length; i += 1) {
  const a = frames[i - 1];
  const b = frames[i];
  if (!a.cameraCenter || !b.cameraCenter) continue;
  const dLng = (b.cameraCenter[0] - a.cameraCenter[0]) * 111320 * Math.cos((b.cameraCenter[1] * Math.PI) / 180);
  const dLat = (b.cameraCenter[1] - a.cameraCenter[1]) * 110540;
  camSteps.push(Math.hypot(dLng, dLat));
}
const meanCam = mean(camSteps);
let camVariance = 0;
let camFreezes = 0;
for (const s of camSteps) {
  camVariance += (s - meanCam) ** 2;
  if (s / meanCam < 0.4) camFreezes += 1;
}
const alphas = all.map((f) => f.alpha ?? 1).filter((a) => a > 0);
const pinned = alphas.filter((a) => a >= 0.999).length;

console.log(`animation frames: ${all.length} · driving frames analysed: ${steps.length}`);
console.log(
  `frame arrivals: ${arrivalGaps.length} · mean ${mean(arrivalGaps).toFixed(0)}ms · p50 ${pct(arrivalGaps, 50).toFixed(0)}ms · p95 ${pct(arrivalGaps, 95).toFixed(0)}ms · max ${arrivalGaps.at(-1)?.toFixed(0)}ms`,
);
console.log(
  `rendered car speed ${speed.toFixed(2)} m/s · step mean ${meanStep.toFixed(3)}m · p95 ${pct([...steps].sort((a, b) => a - b), 95).toFixed(3)}m · max ${Math.max(...steps).toFixed(2)}m`,
);
console.log(
  `JITTER: stddev ${stdDev.toFixed(3)}m (${((stdDev / meanStep) * 100).toFixed(0)}% of the mean step) · FREEZE frames ${freezes} (${((freezes / steps.length) * 100).toFixed(1)}%) · SPIKE frames ${spikes} (${((spikes / steps.length) * 100).toFixed(1)}%)`,
);
console.log(
  `CAMERA: mean step ${meanCam.toFixed(2)}m · stddev ${Math.sqrt(camVariance / Math.max(1, camSteps.length)).toFixed(2)}m · freezes ${camFreezes}`,
);
console.log(`alpha pinned at 1: ${pinned}/${alphas.length} frames (${((pinned / alphas.length) * 100).toFixed(0)}%)`);
