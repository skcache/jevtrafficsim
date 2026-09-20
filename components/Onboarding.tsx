"use client";

/**
 * Onboarding (Task 11 polish pass): a staged first visit.
 *
 * Screen 1 — the title, one line and a single Start action, left-aligned over
 * the city seen whole (the map is the hero, not a blurred backdrop).
 * Screen 2 — one designed configuration object: city scale, traffic,
 * controller and seed, with a deliberate "Enter City" moment.
 */
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useUiStore } from "@/store/ui-store";
import { DiscreteSlider, SeedField, Segmented, TickRow } from "./controls";
import { CURATED_TRIPS, curatedTrip } from "@/cities/chicago-trips";
import {
  CONTROLLER_OPTIONS,
  TRAFFIC_OPTIONS,
  diceSeed,
  normalizeSeed,
  trafficLabel,
} from "./ui-model";

const EASE = [0.22, 1, 0.36, 1] as const;

const fieldVariants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0 },
};

export function Onboarding({ onEnterCity }: { onEnterCity: () => void }) {
  const phase = useUiStore((state) => state.phase);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const tripId = useUiStore((state) => state.tripId);
  const controller = useUiStore((state) => state.controller);
  const seed = useUiStore((state) => state.seed);
  const setPhase = useUiStore((state) => state.setPhase);
  const setTrafficLevel = useUiStore((state) => state.setTrafficLevel);
  const setTripId = useUiStore((state) => state.setTripId);
  const setController = useUiStore((state) => state.setController);
  const setSeed = useUiStore((state) => state.setSeed);
  const [seedText, setSeedText] = useState(String(seed));
  const [rotation, setRotation] = useState(0);

  const rollDice = () => {
    const next = diceSeed();
    setSeed(next);
    setSeedText(String(next));
    setRotation((degrees) => degrees + 540);
  };

  const commitSeed = () => {
    const normalized = normalizeSeed(seedText, seed);
    setSeed(normalized);
    setSeedText(String(normalized));
  };

  const trafficIndex = TRAFFIC_OPTIONS.findIndex((option) => option.value === trafficLevel);
  const trip = curatedTrip(tripId);
  const configuring = phase === "config" || phase === "entering";

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-start px-6 sm:px-10">
      <AnimatePresence mode="wait">
        {phase === "landing" && (
          <motion.div
            key="landing"
            className="pointer-events-auto max-w-lg"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12, scale: 0.99 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <h1 className="on-map-display text-display font-semibold leading-[1.04] tracking-[-0.03em] text-ink">
              Jev Traffic Simulator
            </h1>
            <p className="on-map-display mt-3.5 max-w-sm text-ui leading-relaxed text-ink-70">
              Can your controller beat Chicago traffic?
            </p>
            <button
              type="button"
              onClick={() => setPhase("config")}
              className="mt-7 h-11 rounded-control bg-ink px-6 text-ui font-medium text-surface shadow-[0_1px_2px_rgb(33_29_24/0.14),0_10px_24px_-14px_rgb(33_29_24/0.5)] transition-[opacity,transform] duration-150 hover:opacity-92 active:scale-[0.99]"
            >
              Start
            </button>
          </motion.div>
        )}

        {configuring && (
          <motion.div
            key="config"
            className="surface-overlay pointer-events-auto max-h-[calc(100vh-48px)] w-full max-w-[420px] overflow-y-auto p-6"
            initial={{ opacity: 0, y: 18, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.99 }}
            transition={{ duration: 0.42, ease: EASE }}
          >
            <motion.div
              className="flex flex-col gap-6"
              variants={{ shown: { transition: { staggerChildren: 0.04, delayChildren: 0.04 } } }}
              initial="hidden"
              animate="shown"
            >
              <motion.div variants={fieldVariants} transition={{ duration: 0.3, ease: EASE }}>
                <div className="flex items-baseline justify-between">
                  <span className="label-micro">Trip</span>
                  <span className="text-meta text-ink-52">Metro Chicago</span>
                </div>
                <label className="mt-2.5 block">
                  <span className="sr-only">Chicago trip</span>
                  <select
                    value={tripId}
                    onChange={(event) => setTripId(event.target.value as typeof tripId)}
                    className="h-10 w-full rounded-control border border-hair-strong bg-surface px-3 text-ui font-medium text-ink outline-none transition-colors focus:border-ink-38"
                  >
                    {CURATED_TRIPS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="mt-2 text-meta leading-relaxed text-ink-52">{trip.summary}</p>
              </motion.div>

              <motion.div variants={fieldVariants} transition={{ duration: 0.3, ease: EASE }}>
                <div className="flex items-baseline justify-between">
                  <span className="label-micro">Traffic</span>
                </div>
                <div className="mt-2.5 flex items-baseline gap-2">
                  <span className="text-ui font-medium text-ink">{trafficLabel(trafficLevel)}</span>
                </div>
                <div className="mt-3">
                  <DiscreteSlider
                    value={trafficIndex}
                    count={TRAFFIC_OPTIONS.length}
                    onChange={(index) => setTrafficLevel(TRAFFIC_OPTIONS[index].value)}
                    ariaLabel="Traffic level"
                  />
                  <TickRow
                    labels={TRAFFIC_OPTIONS.map((option) => option.label)}
                    value={trafficIndex}
                    onSelect={(index) => setTrafficLevel(TRAFFIC_OPTIONS[index].value)}
                  />
                </div>
              </motion.div>

              <motion.div variants={fieldVariants} transition={{ duration: 0.3, ease: EASE }}>
                <span className="label-micro">Controller</span>
                <div className="mt-2.5">
                  <Segmented
                    options={CONTROLLER_OPTIONS}
                    value={controller}
                    onChange={setController}
                    layoutId="controller-pill-config"
                    height={36}
                    ariaLabel="Controller"
                  />
                </div>
              </motion.div>

              <motion.div variants={fieldVariants} transition={{ duration: 0.3, ease: EASE }}>
                <SeedField
                  text={seedText}
                  onText={setSeedText}
                  onCommit={commitSeed}
                  onRoll={rollDice}
                  rotation={rotation}
                  label={<span className="label-micro">Seed</span>}
                />
              </motion.div>

              <motion.div
                variants={fieldVariants}
                transition={{ duration: 0.3, ease: EASE }}
                className="mt-2 flex flex-col gap-3"
              >
                <button
                  type="button"
                  disabled={phase === "entering"}
                  onClick={onEnterCity}
                  className="h-11 w-full rounded-control bg-ink text-ui font-medium text-surface shadow-resting transition-[opacity,transform] duration-150 hover:opacity-92 active:scale-[0.995] disabled:opacity-60"
                >
                  {phase === "entering" ? "Entering…" : "Enter City"}
                </button>
                <button
                  type="button"
                  onClick={() => setPhase("landing")}
                  className="self-center text-meta text-ink-52 transition-colors duration-150 hover:text-ink"
                >
                  Back
                </button>
              </motion.div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
