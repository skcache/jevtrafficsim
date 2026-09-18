"use client";

/**
 * SimChrome (Task 11 visual correction): the minimal live interface — a
 * small identity group, a compact controller toggle with Pause/Play, a
 * scenario popover, and a fit-city control. The city dominates the screen;
 * nothing here is a full-width toolbar.
 */
import { AnimatePresence, motion } from "motion/react";
import { Popover } from "radix-ui";
import { useState } from "react";
import type { CitySize, TrafficLevel } from "@/sim/types";
import { useUiStore } from "@/store/ui-store";
import type { ControllerChoice } from "@/worker/protocol";
import {
  CITY_SIZE_OPTIONS,
  CONTROLLER_OPTIONS,
  TRAFFIC_OPTIONS,
  citySizeLabel,
  normalizeSeed,
  sizeForScaleIndex,
  trafficLabel,
} from "./ui-model";

export interface SimChromeProps {
  onPause: () => void;
  onResume: () => void;
  onController: (controller: ControllerChoice) => void;
  onCitySize: (size: CitySize) => void;
  onTrafficLevel: (level: TrafficLevel) => void;
  onSeed: (seed: number) => void;
  onRestart: () => void;
  onNewScenario: () => void;
  onHome: () => void;
}

function Segment({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex overflow-hidden rounded-lg border border-neutral-900/10 bg-white"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`px-2 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors ${
              active ? "bg-neutral-900 text-white" : "text-neutral-500 hover:bg-neutral-100"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

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
      title={label}
      aria-label={label}
      className="flex h-7 w-7 items-center justify-center rounded-lg border border-neutral-900/10 bg-white text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
    >
      {children}
    </button>
  );
}

export function SimChrome(props: SimChromeProps) {
  const phase = useUiStore((state) => state.phase);
  const citySize = useUiStore((state) => state.citySize);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const controller = useUiStore((state) => state.controller);
  const seed = useUiStore((state) => state.seed);
  const running = useUiStore((state) => state.running);
  const runComplete = useUiStore((state) => state.runComplete);
  const error = useUiStore((state) => state.error);
  const scenarioOpen = useUiStore((state) => state.scenarioOpen);
  const setScenarioOpen = useUiStore((state) => state.setScenarioOpen);
  const [seedText, setSeedText] = useState(String(seed));

  if (phase !== "city") {
    return null;
  }

  const commitSeed = () => {
    const normalized = normalizeSeed(seedText, seed);
    setSeedText(String(normalized));
    if (normalized !== seed) {
      props.onSeed(normalized);
    }
  };

  return (
    <>
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-col gap-2">
        <div className="pointer-events-auto rounded-xl border border-neutral-900/10 bg-white/85 px-3 py-2 shadow-sm backdrop-blur-sm">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
            Jev Traffic
          </div>
          <div className="mt-0.5 text-[11px] tracking-wide text-neutral-600">
            Central · {citySizeLabel(citySize)} · {trafficLabel(trafficLevel)}
          </div>
          <div className="text-[10px] tabular-nums tracking-wide text-neutral-400">Seed {seed}</div>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-neutral-900/10 bg-white/85 px-2 py-1.5 shadow-sm backdrop-blur-sm">
          <div className="relative flex rounded-full bg-neutral-100 p-0.5">
            {CONTROLLER_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => props.onController(option.value)}
                className={`relative z-10 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  controller === option.value ? "text-white" : "text-neutral-500 hover:text-neutral-800"
                }`}
              >
                {controller === option.value && (
                  <motion.span
                    layoutId="controller-pill-live"
                    className="absolute inset-0 -z-10 rounded-full bg-neutral-900"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                )}
                {option.label}
              </button>
            ))}
          </div>
          <IconButton label={running ? "Pause" : "Play"} onClick={running ? props.onPause : props.onResume}>
            {running ? (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
                <rect x="1" y="1" width="2.6" height="8" rx="0.6" />
                <rect x="6.4" y="1" width="2.6" height="8" rx="0.6" />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
                <path d="M2 1.2 8.6 5 2 8.8Z" />
              </svg>
            )}
          </IconButton>

          <Popover.Root open={scenarioOpen} onOpenChange={setScenarioOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className="rounded-lg border border-neutral-900/10 bg-white px-2.5 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
              >
                Scenario
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="center"
                sideOffset={8}
                className="z-30 w-72 rounded-xl border border-neutral-900/10 bg-white/95 p-4 shadow-sm backdrop-blur-md"
              >
                <div className="flex flex-col gap-4">
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                      City size · restarts
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {CITY_SIZE_OPTIONS.map((option, index) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            props.onCitySize(sizeForScaleIndex(index));
                            setScenarioOpen(false);
                          }}
                          className={`rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors ${
                            option.value === citySize
                              ? "bg-neutral-900 text-white"
                              : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                      Traffic · restarts
                    </div>
                    <div className="mt-2">
                      <Segment
                        options={TRAFFIC_OPTIONS}
                        value={trafficLevel}
                        onChange={(value) => {
                          props.onTrafficLevel(value as TrafficLevel);
                          setScenarioOpen(false);
                        }}
                        ariaLabel="Traffic level"
                      />
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-400">
                      Seed · restarts
                    </div>
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
                      className="mt-2 w-full rounded-lg border border-neutral-900/10 bg-white px-2.5 py-1.5 text-xs tabular-nums text-neutral-800 outline-none focus:ring-2 focus:ring-neutral-900/10"
                    />
                  </div>
                  <div className="flex gap-2 border-t border-neutral-900/5 pt-3">
                    <button
                      type="button"
                      onClick={() => {
                        props.onRestart();
                        setScenarioOpen(false);
                      }}
                      className="flex-1 rounded-lg border border-neutral-900/10 bg-white py-1.5 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100"
                    >
                      Restart · seed {seed}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        props.onNewScenario();
                        setScenarioOpen(false);
                      }}
                      className="flex-1 rounded-lg bg-neutral-900 py-1.5 text-[11px] font-medium text-white transition-transform hover:scale-[1.01]"
                    >
                      New scenario
                    </button>
                  </div>
                </div>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>

      <div className="pointer-events-none absolute bottom-24 right-4 z-10">
        <IconButton label="Fit city" onClick={props.onHome}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
            <path d="M1.5 4V1.5H4" />
            <path d="M8 1.5h2.5V4" />
            <path d="M10.5 8v2.5H8" />
            <path d="M4 10.5H1.5V8" />
            <circle cx="6" cy="6" r="1.4" fill="currentColor" stroke="none" />
          </svg>
        </IconButton>
      </div>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-x-0 top-16 z-20 flex justify-center px-4"
          >
            <div className="pointer-events-auto max-w-md rounded-lg border border-red-900/20 bg-white/95 px-3 py-2 text-xs text-red-800 shadow-sm">
              Simulation stopped: {error} — use Scenario → Restart to continue.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {runComplete && (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-10 flex justify-center">
          <div className="pointer-events-auto rounded-lg border border-neutral-900/10 bg-white/90 px-3 py-1.5 text-[11px] tracking-wide text-neutral-500 shadow-sm backdrop-blur-sm">
            Run complete — open Scenario to restart or start a new seed.
          </div>
        </div>
      )}
    </>
  );
}
