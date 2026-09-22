/**
 * Camera motion diagnostic: the same jittery ego trajectory, before and after.
 *
 * "Before" reproduces the shipped pre-fix behaviour: the camera target was the
 * car's own position plus a look-ahead, forwarded to the map every frame, with
 * no smoothing of its own. "After" is the follow camera as it ships now.
 *
 * Numbers reported: mean/max per-frame displacement and mean per-frame
 * acceleration change (the second difference — what a viewer reads as vibration).
 */
import { advanceFollow, createFollowState } from "@/render/follow-camera";
import { FOLLOW_SCALE } from "@/render/scale";

interface Sample {
  readonly x: number;
  readonly y: number;
}

/** A car driving 12 m/s with worker-frame jitter and a light-change stall. */
function trajectory(frames: number, dtMs: number): Sample[] {
  const out: Sample[] = [];
  const speedMps = 12;
  for (let frame = 0; frame <= frames; frame += 1) {
    const t = (frame * dtMs) / 1000;
    // Deterministic jitter: two incommensurate sines, amplitude ~0.35 m, which is
    // the frame-arrival wobble the issue describes.
    const jitterX = 0.35 * Math.sin(t * 23.1) + 0.2 * Math.sin(t * 7.7);
    const jitterY = 0.3 * Math.cos(t * 19.3);
    // A stall from 6 s to 12 s, then release: the "snap when the light turns
    // green" case.
    const distance = t < 6 ? speedMps * t : t < 12 ? speedMps * 6 : speedMps * 6 + speedMps * (t - 12);
    out.push({ x: distance + jitterX, y: jitterY });
  }
  return out;
}

function stats(samples: Sample[]) {
  const steps: number[] = [];
  const accelerations: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    steps.push(Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y));
  }
  for (let i = 1; i < steps.length; i += 1) {
    accelerations.push(Math.abs(steps[i] - steps[i - 1]));
  }
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    meanStep: mean(steps),
    maxStep: Math.max(...steps),
    meanJerk: mean(accelerations),
    maxJerk: Math.max(...accelerations),
  };
}

function run(mode: "before" | "after", dtMs: number, frames: number): Sample[] {
  const car = trajectory(frames, dtMs);
  let state = createFollowState();
  const centres: Sample[] = [];
  for (const sample of car) {
    // The car's own heading is its motion direction; the follow code smooths it.
    const ego = { x: sample.x, y: sample.y, speedMps: 12, headingRadians: 0 };
    if (mode === "before") {
      // Pre-fix: target = car + unsmoothed look-ahead, no camera state of its own.
      centres.push({ x: ego.x + FOLLOW_SCALE.lookAheadM, y: ego.y });
      continue;
    }
    const result = advanceFollow(state, ego, dtMs);
    state = result.state;
    const target = result.target ?? [ego.x, ego.y];
    centres.push({ x: target[0], y: target[1] });
  }
  return centres;
}

const frames = 600;
for (const dtMs of [16.7, 33.3]) {
  const before = stats(run("before", dtMs, frames));
  const after = stats(run("after", dtMs, frames));
  console.log(`\n=== ${Math.round(1000 / dtMs)} fps (dt ${dtMs.toFixed(1)} ms) ===`);
  for (const [label, s] of [
    ["before", before],
    ["after ", after],
  ] as const) {
    console.log(
      `${label}  mean step ${s.meanStep.toFixed(3)} m · max step ${s.maxStep.toFixed(3)} m · ` +
        `mean |Δstep| ${s.meanJerk.toFixed(4)} m · max |Δstep| ${s.maxJerk.toFixed(4)} m`,
    );
  }
  console.log(
    `         jitter reduced ${(before.meanJerk / after.meanJerk).toFixed(1)}x (mean), ` +
      `spikes reduced ${(before.maxJerk / after.maxJerk).toFixed(1)}x (max)`,
  );
}
