"use client";

/**
 * Onboarding (Task 11 visual correction): a staged first visit.
 *
 * Screen 1 — the title and a single Start action over a dimmed map.
 * Screen 2 — a centred configuration card: city scale, traffic, controller
 * and seed, with a deliberate "Enter City" transition into the simulator.
 */
import { AnimatePresence, motion } from "motion/react";
import { Slider } from "radix-ui";
import { useState } from "react";
import { useUiStore } from "@/store/ui-store";
import {
  CITY_SIZE_OPTIONS,
  CONTROLLER_OPTIONS,
  TRAFFIC_OPTIONS,
  citySizeDescription,
  citySizeLabel,
  diceSeed,
  normalizeSeed,
  sizeForScaleIndex,
  trafficLabel,
} from "./ui-model";

function FieldLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
      {children}
    </div>
  );
}

function DiscreteSlider({
  value,
  max,
  onChange,
  ariaLabel,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  return (
    <Slider.Root
      className="relative flex h-5 w-full touch-none select-none items-center"
      min={0}
      max={max}
      step={1}
      value={[value]}
      onValueChange={([next]) => onChange(next)}
      aria-label={ariaLabel}
    >
      <Slider.Track className="relative h-[3px] grow rounded-full bg-neutral-900/10">
        <Slider.Range className="absolute h-full rounded-full bg-neutral-900" />
      </Slider.Track>
      <Slider.Thumb className="block h-4 w-4 rounded-full border border-neutral-900/20 bg-white shadow-sm transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/20 active:scale-110" />
    </Slider.Root>
  );
}

export function Onboarding({ onEnterCity }: { onEnterCity: () => void }) {
  const phase = useUiStore((state) => state.phase);
  const citySize = useUiStore((state) => state.citySize);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const controller = useUiStore((state) => state.controller);
  const seed = useUiStore((state) => state.seed);
  const setPhase = useUiStore((state) => state.setPhase);
  const setCitySize = useUiStore((state) => state.setCitySize);
  const setTrafficLevel = useUiStore((state) => state.setTrafficLevel);
  const setController = useUiStore((state) => state.setController);
  const setSeed = useUiStore((state) => state.setSeed);
  const [seedText, setSeedText] = useState(String(seed));
  const [diceSpins, setDiceSpins] = useState(0);

  const rollDice = () => {
    const next = diceSeed();
    setSeed(next);
    setSeedText(String(next));
    setDiceSpins((spins) => spins + 1);
  };

  const commitSeed = () => {
    const normalized = normalizeSeed(seedText, seed);
    setSeed(normalized);
    setSeedText(String(normalized));
  };

  const trafficIndex = TRAFFIC_OPTIONS.findIndex((option) => option.value === trafficLevel);

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-4">
      <AnimatePresence mode="wait">
        {phase === "landing" && (
          <motion.div
            key="landing"
            className="pointer-events-auto flex max-w-md flex-col items-center text-center"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          >
            <h1 className="text-4xl font-semibold tracking-tight text-neutral-900 sm:text-5xl">
              Jev Traffic Simulator
            </h1>
            <p className="mt-3 text-sm text-neutral-500">
              Control a living city. Break it if you can.
            </p>
            <button
              type="button"
              onClick={() => setPhase("config")}
              className="mt-8 rounded-full bg-neutral-900 px-7 py-2.5 text-sm font-medium text-white shadow-sm transition-transform hover:scale-[1.02] active:scale-[0.98]"
            >
              Start
            </button>
          </motion.div>
        )}

        {(phase === "config" || phase === "entering") && (
          <motion.div
            key="config"
            className="pointer-events-auto w-full max-w-md rounded-2xl border border-neutral-900/10 bg-white/90 px-6 py-6 shadow-sm backdrop-blur-md"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.98 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex flex-col gap-6">
              <div>
                <FieldLabel>City size</FieldLabel>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-xl font-semibold tracking-tight text-neutral-900">
                    {citySizeLabel(citySize)}
                  </span>
                  <span className="text-xs text-neutral-400">{citySizeDescription(citySize)}</span>
                </div>
                <div className="mt-3">
                  <DiscreteSlider
                    value={CITY_SIZE_OPTIONS.findIndex((option) => option.value === citySize)}
                    max={CITY_SIZE_OPTIONS.length - 1}
                    onChange={(index) => setCitySize(sizeForScaleIndex(index))}
                    ariaLabel="City size"
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-neutral-400">
                  {CITY_SIZE_OPTIONS.map((option) => (
                    <span key={option.value}>{option.label}</span>
                  ))}
                </div>
              </div>

              <div>
                <FieldLabel>Traffic</FieldLabel>
                <div className="mt-2 flex items-baseline justify-between">
                  <span className="text-xl font-semibold tracking-tight text-neutral-900">
                    {trafficLabel(trafficLevel)}
                  </span>
                </div>
                <div className="mt-3">
                  <DiscreteSlider
                    value={trafficIndex}
                    max={TRAFFIC_OPTIONS.length - 1}
                    onChange={(index) => setTrafficLevel(TRAFFIC_OPTIONS[index].value)}
                    ariaLabel="Traffic level"
                  />
                </div>
                <div className="mt-1.5 flex justify-between text-[10px] uppercase tracking-wide text-neutral-400">
                  {TRAFFIC_OPTIONS.map((option) => (
                    <span key={option.value}>{option.label}</span>
                  ))}
                </div>
              </div>

              <div>
                <FieldLabel>Controller</FieldLabel>
                <div className="relative mt-2 flex rounded-full border border-neutral-900/10 bg-neutral-50 p-0.5">
                  {CONTROLLER_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setController(option.value)}
                      className={`relative z-10 flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                        controller === option.value ? "text-white" : "text-neutral-500 hover:text-neutral-800"
                      }`}
                    >
                      {controller === option.value && (
                        <motion.span
                          layoutId="controller-pill"
                          className="absolute inset-0 -z-10 rounded-full bg-neutral-900"
                          transition={{ type: "spring", stiffness: 420, damping: 34 }}
                        />
                      )}
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <FieldLabel>Seed</FieldLabel>
                <div className="relative mt-2 flex items-center">
                  <input
                    value={seedText}
                    onChange={(event) => setSeedText(event.target.value)}
                    onBlur={commitSeed}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        commitSeed();
                      }
                    }}
                    inputMode="numeric"
                    aria-label="Seed"
                    className="w-full rounded-lg border border-neutral-900/10 bg-white py-2 pl-3 pr-12 text-sm tabular-nums text-neutral-800 outline-none transition-shadow focus:ring-2 focus:ring-neutral-900/10"
                  />
                  <button
                    type="button"
                    onClick={rollDice}
                    aria-label="Random seed"
                    className="absolute right-1.5 flex h-7 w-8 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                  >
                    <motion.span
                      key={diceSpins}
                      initial={{ rotate: 0, scale: 1 }}
                      animate={{ rotate: [0, -140, 160, 360], scale: [1, 1.2, 0.95, 1] }}
                      transition={{ duration: 0.6, ease: "easeInOut" }}
                      className="text-base leading-none"
                    >
                      ⚄
                    </motion.span>
                  </button>
                </div>
              </div>

              <button
                type="button"
                disabled={phase === "entering"}
                onClick={onEnterCity}
                className="mt-1 w-full rounded-lg bg-neutral-900 py-2.5 text-sm font-medium text-white transition-transform hover:scale-[1.01] active:scale-[0.99] disabled:opacity-60"
              >
                {phase === "entering" ? "Entering…" : "Enter City"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
