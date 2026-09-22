"use client";

/**
 * SimChrome (Task 11 polish pass): the live product's chrome in discrete
 * zones — nothing spans the viewport.
 *
 *   top-left      run identity (bare type, hover reveals "Change setup…")
 *   top-centre    controller · pause/play · scenario
 *   bottom-right  camera stack (zoom in / out / fit city)
 *   bottom-centre run-complete payoff and error state (above the dock)
 *
 * Panels are the only overlay material; everything else is type on the map.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { TrafficLevel } from "@/sim/types";
import { CURATED_TRIPS, curatedTrip, type CuratedTripId } from "@/cities/chicago-trips";
import { useUiStore } from "@/store/ui-store";
import type { ControllerChoice } from "@/worker/protocol";
import { DiscreteSlider, SeedField, Segmented, TickRow } from "./controls";
import { ComparisonPanel } from "./ComparisonPanel";
import {
  BASELINE_COMPUTING_DETAIL,
  runShowsNonComparable,
  BASELINE_COMPUTING_TEXT,
  BASELINE_FAILED_DETAIL,
  BASELINE_FAILED_TEXT,
  BASELINE_RETRY_LABEL,
  baselinePanelState,
  discardCopy,
} from "./ui-model";
import {
  CONTROLLER_OPTIONS,
  DRIVER_OPTIONS,
  TRAFFIC_OPTIONS,
  diceSeed,
  driverLabel,
  normalizeSeed,
  policyLabel,
  trafficLabel,
} from "./ui-model";

import type { DriverStrategy } from "@/sim/driver";

interface SimChromeProps {
  /** Developer controls (?debug): controller choice and the raw seed. */
  debug: boolean;
  /** Follow camera state, mirrored from the map. */
  following: boolean;
  onFollow: () => void;
  onPause: () => void;
  onResume: () => void;
  onController: (controller: ControllerChoice) => void;
  onTripId: (tripId: CuratedTripId) => void;
  onTrafficLevel: (trafficLevel: TrafficLevel) => void;
  onDriver: (driver: DriverStrategy) => void;
  onSeed: (seed: number) => void;
  onRestart: () => void;
  onNewScenario: () => void;
  /** Re-ask the baseline worker for this scenario (Issue #39 failure state). */
  onRetryBaselines: () => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onHome: () => void;
  onChangeSetup: () => void;
}

const EASE = [0.22, 1, 0.36, 1] as const;

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-[30px] w-[30px] items-center justify-center rounded-[6px] text-ink-70 transition-colors duration-150 hover:bg-ink/[0.05] hover:text-ink active:scale-[0.96]"
    >
      {children}
    </button>
  );
}

const glyph = {
  width: 13,
  height: 13,
  viewBox: "0 0 13 13",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/**
 * Scenario popover: the same decisions as onboarding, editable live. Trip and
 * driver rebuild the run (they define who and where the challenge is); traffic
 * is applied to the world in progress. The raw seed is a developer control.
 */
function ScenarioPanel({
  onTripId,
  onTrafficLevel,
  onDriver,
  onSeed,
  debug,
}: Pick<SimChromeProps, "onTripId" | "onTrafficLevel" | "onDriver" | "onSeed" | "debug">) {
  const tripId = useUiStore((state) => state.tripId);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const driver = useUiStore((state) => state.driver);
  const seed = useUiStore((state) => state.seed);
  const setScenarioOpen = useUiStore((state) => state.setScenarioOpen);
  const [seedText, setSeedText] = useState(String(seed));
  const [rotation, setRotation] = useState(0);
  const [syncedSeed, setSyncedSeed] = useState(seed);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Adjust state during render when the store's seed changes (no effect).
  if (syncedSeed !== seed) {
    setSyncedSeed(seed);
    setSeedText(String(seed));
  }

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current && !panelRef.current.contains(target)) {
        setScenarioOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setScenarioOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [setScenarioOpen]);

  const trip = curatedTrip(tripId);
  const trafficIndex = TRAFFIC_OPTIONS.findIndex((option) => option.value === trafficLevel);

  return (
    <motion.div
      ref={panelRef}
      className="surface-overlay absolute left-1/2 top-14 z-20 w-[268px] -translate-x-1/2 p-4"
      initial={{ opacity: 0, y: -6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.985 }}
      transition={{ duration: 0.2, ease: EASE }}
      style={{ transformOrigin: "top center" }}
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="label-micro">Trip</span>
            <span className="text-meta text-ink-52">Metro</span>
          </div>
          <select
            value={tripId}
            onChange={(event) => onTripId(event.target.value as CuratedTripId)}
            className="mt-2 h-9 w-full rounded-control border border-hair-strong bg-surface px-2.5 text-meta font-medium text-ink outline-none"
          >
            {CURATED_TRIPS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <p className="mt-1.5 text-micro leading-relaxed text-ink-52">{trip.summary}</p>
        </div>
        <div>
          <span className="label-micro">Traffic</span>
          <div className="mt-2">
            <DiscreteSlider
              value={trafficIndex}
              count={TRAFFIC_OPTIONS.length}
              onChange={(index) => onTrafficLevel(TRAFFIC_OPTIONS[index].value)}
              ariaLabel="Traffic level"
            />
            <TickRow
              labels={TRAFFIC_OPTIONS.map((option) => option.label)}
              value={trafficIndex}
              // Live mid-trip: this goes through the same handler as the
              // slider, which applies the new level to the RUNNING world
              // instead of rebuilding it.
              onSelect={(index) => onTrafficLevel(TRAFFIC_OPTIONS[index].value)}
            />
          </div>
        </div>
        <div>
          <span className="label-micro">Driver</span>
          <div className="mt-2">
            <Segmented
              options={DRIVER_OPTIONS}
              value={driver}
              onChange={onDriver}
              layoutId="driver-pill-live"
              height={30}
              ariaLabel="Driver"
            />
          </div>
        </div>
        {debug && (
          <SeedField
            text={seedText}
            onText={setSeedText}
            onCommit={() => {
              const next = normalizeSeed(seedText, seed);
              setSeedText(String(next));
              if (next !== seed) {
                onSeed(next);
              }
            }}
            onRoll={() => {
              const next = diceSeed();
              setSeedText(String(next));
              setRotation((degrees) => degrees + 540);
              onSeed(next);
            }}
            rotation={rotation}
            label={<span className="label-micro">Seed</span>}
          />
        )}
      </div>
    </motion.div>
  );
}

export function SimChrome(props: SimChromeProps) {
  const phase = useUiStore((state) => state.phase);
  const running = useUiStore((state) => state.running);
  const controller = useUiStore((state) => state.controller);
  const driver = useUiStore((state) => state.driver);
  const scenarioFingerprint = useUiStore((state) => state.scenarioFingerprint);
  const tripId = useUiStore((state) => state.tripId);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const scenarioOpen = useUiStore((state) => state.scenarioOpen);
  const setScenarioOpen = useUiStore((state) => state.setScenarioOpen);
  const runComplete = useUiStore((state) => state.runComplete);
  const error = useUiStore((state) => state.error);
  const policy = useUiStore((state) => state.policy);
  const liveResult = useUiStore((state) => state.liveResult);
  const baselines = useUiStore((state) => state.baselines);
  const baselinesRunning = useUiStore((state) => state.baselinesRunning);
  const baselinesFailed = useUiStore((state) => state.baselinesFailed);
  const modified = useUiStore((state) => state.modified);
  const manualIncidents = useUiStore((state) => state.manualIncidents);
  const pendingDiscard = useUiStore((state) => state.pendingDiscard);
  const surgeFlash = useUiStore((state) => state.surgeFlash);
  const surgeVisible = useUiStore((state) => state.surgeVisible);
  // "Live" means the city is the surface the user is looking at. A completed run
  // always is: the payoff panel is the whole point of finishing, and a run entered
  // without onboarding (or through ?debug) never flips the phase on its own.
  const live = phase === "city" || runComplete;
  const activeTrip = curatedTrip(tripId);
  const panel = baselinePanelState({
    runComplete,
    hasBaselines: baselines !== null,
    running: baselinesRunning,
    failed: baselinesFailed !== null,
  });
  const discard = pendingDiscard === null ? null : discardCopy(pendingDiscard);

  return (
    <>
      {/* Top-left: run identity. */}
      <AnimatePresence>
        {live && (
          <motion.div
            key="identity"
            className="pointer-events-none absolute left-4 top-4 z-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.34, ease: EASE }}
          >
            <div className="surface pointer-events-auto flex flex-col items-start gap-2.5 px-3.5 py-3">
              <div className="flex flex-col items-start gap-1">
                <span className="label-micro">Jev Traffic · Chicago</span>
                <span className="text-ui font-semibold leading-tight tracking-tight text-ink">
                  {activeTrip.label}
                </span>
                <span className="text-meta leading-tight text-ink-52">
                  {trafficLabel(trafficLevel)} · {driverLabel(driver)} driver
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="label-micro text-ink-38">Signals</span>
                <span className="text-meta leading-none text-ink-70">
                  {(policyLabel(controller, policy) ?? { text: controller }).text}
                </span>
              </div>
              {props.debug && (
                <div className="flex items-center gap-2">
                  <span className="label-micro text-ink-38">Scenario</span>
                  <span className="value-num text-micro leading-none text-ink-70">
                    {scenarioFingerprint ?? "—"}
                  </span>
                </div>
              )}
              {runShowsNonComparable({ modified, manualIncidents }) && (
                <div className="flex items-center gap-2" role="status">
                  <span className="label-micro text-ink-38">Run</span>
                  <span className="text-micro leading-none text-ink-70">
                    modified · not comparable
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={props.onChangeSetup}
                className="text-micro font-medium text-ink-38 underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline"
              >
                Change setup…
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top-centre: utilities. */}
      <AnimatePresence>
        {live && (
          <motion.div
            key="utilities"
            className="absolute left-1/2 top-4 z-20 -translate-x-1/2"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.34, delay: 0.06, ease: EASE }}
          >
            <div className="surface flex items-center gap-[3px] p-[3px]">
              {/*
                The visible run is Jev. Choosing another controller by hand is a
                developer control, so the picker only exists behind ?debug — a
                public visitor cannot turn the experiment into a different one.
              */}
              {props.debug && (
                <>
                  <Segmented
                    options={CONTROLLER_OPTIONS}
                    value={controller}
                    onChange={props.onController}
                    layoutId="controller-pill-live"
                    height={30}
                    ariaLabel="Controller"
                  />
                  <span className="mx-[3px] h-4 w-px bg-hair" aria-hidden="true" />
                </>
              )}
              <IconButton
                label={running ? "Pause" : "Play"}
                onClick={running ? props.onPause : props.onResume}
              >
                {running ? (
                  <svg {...glyph}>
                    <path d="M4.6 2.6v7.8M8.4 2.6v7.8" />
                  </svg>
                ) : (
                  <svg {...glyph}>
                    <path d="M4 2.6 10 6.5 4 10.4z" fill="currentColor" stroke="none" />
                  </svg>
                )}
              </IconButton>
              <span className="mx-[3px] h-4 w-px bg-hair" aria-hidden="true" />
              <button
                type="button"
                onClick={props.onFollow}
                aria-pressed={props.following}
                aria-label={props.following ? "Following the car" : "Recenter on the car"}
                title={props.following ? "Following the car" : "Recenter on the car"}
                className={`flex h-[30px] items-center gap-[6px] rounded-[6px] px-2.5 text-meta font-medium transition-colors duration-150 ${
                  props.following ? "text-ink-70 hover:bg-ink/[0.05] hover:text-ink" : "bg-ink/[0.06] text-ink"
                }`}
              >
                <svg {...glyph}>
                  <circle cx="6.5" cy="6.5" r="2.1" />
                  <path d="M6.5 1.4v1.9M6.5 9.7v1.9M1.4 6.5h1.9M9.7 6.5h1.9" />
                </svg>
                {props.following ? "Following" : "Recenter"}
              </button>
              <span className="mx-[3px] h-4 w-px bg-hair" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setScenarioOpen(!scenarioOpen)}
                aria-expanded={scenarioOpen}
                className={`flex h-[30px] items-center gap-[6px] rounded-[6px] px-2.5 text-meta font-medium transition-colors duration-150 ${
                  scenarioOpen ? "bg-ink/[0.06] text-ink" : "text-ink-70 hover:bg-ink/[0.05] hover:text-ink"
                } focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink/25`}
              >
                <svg {...glyph}>
                  <path d="M2 4h9M2 6.5h9M2 9h9" />
                  <circle cx="4.6" cy="4" r="1.2" fill="currentColor" stroke="none" />
                  <circle cx="8.4" cy="6.5" r="1.2" fill="currentColor" stroke="none" />
                  <circle cx="5.8" cy="9" r="1.2" fill="currentColor" stroke="none" />
                </svg>
                Scenario
              </button>
            </div>
            <AnimatePresence>
              {scenarioOpen && (
                <ScenarioPanel
                  onTripId={props.onTripId}
                  onTrafficLevel={props.onTrafficLevel}
                  onDriver={props.onDriver}
                  onSeed={props.onSeed}
                  debug={props.debug}
                />
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top-centre: demand surge confirmation (transient). */}
      <AnimatePresence>
        {live && surgeVisible && (
          <motion.div
            key={`surge-${surgeFlash}`}
            className="surface pointer-events-none absolute left-1/2 top-16 z-10 flex items-center gap-2 px-3 py-1.5"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#b0392b]" aria-hidden="true" />
            <span className="text-meta font-medium text-ink">+5× demand</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom-centre: the payoff IS the comparison, then the error state. */}
      <AnimatePresence>
        {live && runComplete && (
          <motion.div
            key="complete"
            className="surface-overlay absolute bottom-20 left-1/2 z-20 max-h-[calc(100vh-160px)] w-[520px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-y-auto p-4"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.28, ease: EASE }}
          >
            <div className="flex items-baseline justify-between">
              <span className="label-micro">Run complete</span>
              <span className="value-num text-meta text-ink-52">
                {Math.round((liveResult?.simulatedMs ?? 0) / 1000)}s simulated
              </span>
            </div>
            <div className="mt-3">
              {panel === "comparison" && liveResult !== null && baselines !== null ? (
                <ComparisonPanel baselines={baselines} live={liveResult} policy={policy} />
              ) : null}
              {panel === "computing" && (
                <div role="status" aria-live="polite">
                  <p className="text-meta font-medium text-ink">{BASELINE_COMPUTING_TEXT}</p>
                  <p className="mt-1 text-micro leading-relaxed text-ink-52">
                    {BASELINE_COMPUTING_DETAIL}
                  </p>
                </div>
              )}
              {panel === "failed" && (
                <div role="alert" className="flex flex-col items-start gap-2">
                  <div>
                    <p className="text-meta font-medium text-ink">{BASELINE_FAILED_TEXT}</p>
                    <p className="mt-1 text-micro leading-relaxed text-ink-52">
                      {baselinesFailed ?? BASELINE_FAILED_DETAIL}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={props.onRetryBaselines}
                    className="h-8 rounded-control border border-hair-strong px-3 text-meta font-medium text-ink transition-colors duration-150 hover:bg-ink/[0.04] active:scale-[0.99]"
                  >
                    {BASELINE_RETRY_LABEL}
                  </button>
                </div>
              )}
              {panel === "waiting" && (
                <p className="text-meta leading-relaxed text-ink-52">
                  The run is still playing…
                </p>
              )}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={props.onRestart}
                className="h-8 flex-1 rounded-control bg-ink text-meta font-medium text-surface transition-opacity duration-150 hover:opacity-90 active:scale-[0.99]"
              >
                Restart
              </button>
              <button
                type="button"
                onClick={props.onNewScenario}
                className="h-8 flex-1 rounded-control border border-hair-strong text-meta font-medium text-ink transition-colors duration-150 hover:bg-ink/[0.04] active:scale-[0.99]"
              >
                New scenario
              </button>
            </div>
          </motion.div>
        )}
        {live && error !== null && !runComplete && (
          <motion.div
            key="error"
            className="surface-overlay absolute bottom-20 left-1/2 z-20 flex max-w-[420px] -translate-x-1/2 items-center gap-2 px-3 py-2"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.24, ease: EASE }}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#b0392b]" aria-hidden="true" />
            <span className="text-meta text-ink-70">{error}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Above the dock: the one action that throws the run away asks first. */}
      <AnimatePresence>
        {live && discard !== null && (
          <motion.div
            key="discard"
            role="alertdialog"
            aria-label={discard.title}
            className="surface-overlay absolute bottom-16 left-1/2 z-30 flex w-[380px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col gap-2 p-3.5"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: EASE }}
          >
            <span className="text-meta font-medium text-ink">{discard.title}</span>
            <p className="text-micro leading-relaxed text-ink-52">{discard.body}</p>
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                autoFocus
                onClick={props.onConfirmDiscard}
                className="h-8 flex-1 rounded-control bg-ink text-meta font-medium text-surface transition-opacity duration-150 hover:opacity-90 active:scale-[0.99]"
              >
                {discard.confirm}
              </button>
              <button
                type="button"
                onClick={props.onCancelDiscard}
                className="h-8 flex-1 rounded-control border border-hair-strong text-meta font-medium text-ink transition-colors duration-150 hover:bg-ink/[0.04] active:scale-[0.99]"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom-right: camera stack (replaces MapLibre's default control). */}
      <motion.div
        className="absolute bottom-4 right-4 z-10"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: live ? 1 : 0, y: live ? 0 : 6 }}
        transition={{ duration: 0.34, delay: live ? 0.24 : 0, ease: EASE }}
      >
        <div className="surface pointer-events-auto flex flex-col items-center divide-y divide-hair p-[3px]">
          <IconButton label="Zoom in" onClick={props.onZoomIn}>
            <svg {...glyph}>
              <path d="M6.5 3v7M3 6.5h7" />
            </svg>
          </IconButton>
          <IconButton label="Zoom out" onClick={props.onZoomOut}>
            <svg {...glyph}>
              <path d="M3 6.5h7" />
            </svg>
          </IconButton>
          <IconButton label="Fit city" onClick={props.onHome}>
            <svg {...glyph}>
              <path d="M2 4.6V2h2.6M10.4 2H13v2.6M13 10.4V13h-2.6M2 10.4V13h2.6" />
              <circle cx="6.5" cy="6.5" r="1.6" />
            </svg>
          </IconButton>
        </div>
      </motion.div>
    </>
  );
}
