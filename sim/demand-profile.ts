/**
 * Production demand profiles — the ONE place that decides how busy Chicago is.
 *
 * Every path that builds a world goes through here: the visible worker, the
 * baseline worker, the benchmark and the receipts tooling. If the visible run
 * used one multiplier and the headless baselines another, the three-way
 * comparison would be a lie, so the profile is derived from the traffic LEVEL
 * alone and there is no second knob anywhere else.
 *
 * The numbers were calibrated by sweep (scripts/scenario-report.ts), not chosen
 * by taste: at 1x the network ran 95% free and the public build looked empty; at
 * ~2.25x Everyday shows standing traffic, amber segments and occasional red
 * queues while still clearing; at ~2.75x Rush Hour holds several simultaneous
 * amber/red corridors with real bottlenecks and materially slower travel, and
 * throughput is still rising — so it is stressed, not gridlocked.
 *
 * `label` is part of the scenario fingerprint. Demand semantics changed here, so
 * a trace or baseline recorded against the old world must not be able to pass
 * itself off as this one.
 */
import { generateDemand, type DemandOptions } from "./demand";
import type { DemandShapeName } from "./demand-shape";
import type { ScheduledSpawn } from "./engine";
import type { TrafficLevel } from "./types";

/**
 * Bump when a profile's numbers or shapes change in a way that alters the world.
 *
 * v2: rush hour 2.75x -> 3.75x. Measured, not chosen: at 2.75x the shipping
 * downtown-bound shape put 7 585 vehicles on the network with 6.2% of roads red,
 * and the sweep to 4.0x showed throughput still rising (402.8 -> 462.5/min) with
 * every curated trip still completing. 3.75x takes the red share to 10.2% at
 * the highest throughput that is not yet paying for it in starvation or waits
 * (4.0x: starvation 52 vs 31, p95 wait 223s vs 208s, for 1.3% more throughput).
 *
 * v3: the rush-hour shape now weights OD pairs by road FUNCTIONAL CLASS
 * (expressway endpoints > arterial endpoints > everything else) instead of
 * carrying a flat base weight for every pair, so the same 3.75x volume lands on
 * the roads Chicago actually loads.
 */
export const DEMAND_PROFILE_VERSION = 3;

export interface DemandProfile {
  /** Volume multiplier on the level's active-vehicle target. */
  readonly multiplier: number;
  /** Deterministic OD shape; "uniform" is the pre-calibration behaviour. */
  readonly shape: DemandShapeName;
  /** Stable identity, carried into the scenario fingerprint. */
  readonly label: string;
}

/**
 * The shipping profiles.
 *
 * `light` stays exactly as it always was: it is a debugging level, and changing
 * it would move every test fixture that uses it.
 */
export const PRODUCTION_DEMAND: Record<TrafficLevel, DemandProfile> = {
  light: { multiplier: 1, shape: "uniform", label: "light-v1" },
  // Commuter-weighted: long fast corridors carry most of the load, which is what
  // produces the "many roads busy, a few congested" Everyday look.
  everyday: { multiplier: 2.25, shape: "corridor-heavy", label: "everyday-2.25-corridor-v1" },
  // Downtown-bound morning peak: anywhere -> core along the road hierarchy -
  // expressway endpoints dominate the OD weights, arterials next, so the load
  // lands where Chicago actually puts it. 3.75x is the measured ceiling of the
  // usable range - see DEMAND_PROFILE_VERSION.
  "rush-hour": { multiplier: 3.75, shape: "downtown-bound", label: "rush-3.75-downtown-v2" },
};

export function demandProfileFor(level: TrafficLevel): DemandProfile {
  const profile = PRODUCTION_DEMAND[level];
  if (profile === undefined) {
    throw new RangeError(`no production demand profile for level "${String(level)}"`);
  }
  return profile;
}

/** The production spawn schedule for a level: the single entry point. */
export function productionDemand(
  options: Omit<DemandOptions, "multiplier" | "shape">,
): ScheduledSpawn[] {
  const profile = demandProfileFor(options.level);
  return generateDemand({ ...options, multiplier: profile.multiplier, shape: profile.shape });
}
