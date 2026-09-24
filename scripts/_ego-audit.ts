/**
 * Analyse a captured ego trace against the road geometry.
 *
 * Separates the two things a viewer sees:
 *   - MID-BLOCK: the car is driving along a street. Here the nose must match the
 *     direction of travel and the car must sit in its lane. Anything else is the
 *     defect the user reports.
 *   - AT A JUNCTION: the car is rounding a corner, where the rendered path is a
 *     connector curve by design. Deviation there is expected, within the box.
 */
import { readFileSync } from "node:fs";
import { loadBenchmarkModel } from "@/benchmark/model";
import { laneCentreOffsetMetres, carriagewayPairs } from "@/render/road-presentation";

type Sample = {
  t: number;
  x: number;
  y: number;
  h: number;
  road: number;
  progress: number | null;
  route: { free: number; slowed: number; congested: number } | null;
};

const samples = JSON.parse(readFileSync("/tmp/ship-qa/ego-samples.json", "utf8")) as Sample[];
const model = loadBenchmarkModel();
const laneOffsets = model.city.roads.map((road) =>
  Math.abs(laneCentreOffsetMetres(model, road.id, carriagewayPairs(model))),
);

function nearest(point: { x: number; y: number }, path: readonly (readonly number[])[]) {
  let best = { d: Infinity, tx: 0, ty: 0 };
  for (let i = 0; i + 1 < path.length; i += 1) {
    const [ax, ay] = path[i];
    const [bx, by] = path[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / len2));
    const d = Math.hypot(point.x - (ax + dx * t), point.y - (ay + dy * t));
    if (d < best.d) best = { d, tx: dx, ty: dy };
  }
  return best;
}

const roadLength = new Map(model.city.roads.map((road) => [road.id, road.length]));
const isJunctionish = (i: number) => {
  for (let k = Math.max(1, i - 2); k <= Math.min(samples.length - 1, i + 2); k += 1) {
    if (samples[k].road !== samples[k - 1].road) return true;
  }
  const s = samples[i];
  const len = roadLength.get(s.road);
  if (s.progress === null || len === undefined) return true;
  // Within 18 m of either end of the road: entering or leaving the junction.
  return s.progress < 18 || len - s.progress < 18;
};

let midBlockFrames = 0;
let worstBodyMotion = 0;
let worstLateral = 0;
let worstHeadingVsRoad = 0;
const offenders: string[] = [];
for (let i = 2; i < samples.length - 2; i += 1) {
  const a = samples[i - 1];
  const b = samples[i];
  if (a.road !== b.road) continue;
  const moved = Math.hypot(b.x - a.x, b.y - a.y);
  if (moved < 1) continue;
  if (isJunctionish(i)) continue;
  midBlockFrames += 1;
  const motion = Math.atan2(b.y - a.y, b.x - a.x);
  let bodyMotion = Math.abs(motion - b.h);
  bodyMotion = Math.min(bodyMotion, Math.abs(bodyMotion - Math.PI * 2));
  const path = model.directedPaths[b.road];
  const near = path ? nearest({ x: b.x, y: b.y }, path) : null;
  if (near) {
    const lateralExcess = near.d - (laneOffsets[b.road] ?? 0);
    worstLateral = Math.max(worstLateral, lateralExcess);
    const tangent = Math.atan2(near.ty, near.tx);
    let headVsRoad = Math.abs(tangent - b.h);
    headVsRoad = Math.min(headVsRoad, Math.abs(headVsRoad - Math.PI * 2));
    worstHeadingVsRoad = Math.max(worstHeadingVsRoad, (headVsRoad * 180) / Math.PI);
  }
  const deg = (bodyMotion * 180) / Math.PI;
  worstBodyMotion = Math.max(worstBodyMotion, deg);
  if (deg > 25 && offenders.length < 10) {
    offenders.push(`t=${b.t} moved=${moved.toFixed(1)}m body-vs-motion=${deg.toFixed(0)}deg lateral=${near?.d.toFixed(1)}m road=${b.road} progress=${b.progress?.toFixed(0)}`);
  }
}

const congested = samples.filter((s) => s.route && s.route.congested > 0).length;
const slowed = samples.filter((s) => s.route && s.route.slowed > 0).length;

console.log(`MID-BLOCK frames analysed: ${midBlockFrames}`);
console.log(`  worst body-vs-motion: ${worstBodyMotion.toFixed(1)} deg`);
console.log(`  worst lateral beyond the outer lane: ${worstLateral.toFixed(2)} m`);
console.log(`  worst heading vs road tangent: ${worstHeadingVsRoad.toFixed(1)} deg`);
console.log(`  offenders > 25 deg: ${offenders.length}`);
for (const line of offenders) console.log(`    ${line}`);
console.log(`ROUTE traffic classes: frames with a slowed segment ${slowed} · with a congested segment ${congested} of ${samples.length}`);
