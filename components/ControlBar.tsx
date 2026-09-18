"use client";

/**
 * ControlBar (Task 11): floating top bar. City/traffic changes reset the run
 * with the same seed; controller changes never reset. Compact segmented
 * controls, no design system.
 */
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { ControllerChoice } from "@/worker/protocol";
import { useUiStore } from "@/store/ui-store";

export interface ControlBarProps {
  onCitySize: (size: CitySize) => void;
  onTrafficLevel: (level: TrafficLevel) => void;
  onController: (controller: ControllerChoice) => void;
  onStart: () => void;
  onPause: () => void;
  onRestart: () => void;
  onNewSeed: () => void;
}

const CITY_SIZES: readonly { value: CitySize; label: string }[] = [
  { value: "small", label: "Small" },
  { value: "small-medium", label: "Small-Med" },
  { value: "medium", label: "Medium" },
  { value: "medium-large", label: "Med-Large" },
  { value: "large", label: "Large" },
];

const TRAFFIC_LEVELS: readonly { value: TrafficLevel; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "everyday", label: "Everyday" },
  { value: "rush-hour", label: "Rush" },
];

const CONTROLLERS: readonly { value: ControllerChoice; label: string }[] = [
  { value: "fixed", label: "Fixed" },
  { value: "adaptive", label: "Adaptive" },
];

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      <div className="flex overflow-hidden rounded-md border border-neutral-900/10 bg-white">
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                active
                  ? "bg-neutral-900 text-white"
                  : "text-neutral-600 hover:bg-neutral-100"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
        primary
          ? "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-700"
          : "border-neutral-900/10 bg-white text-neutral-600 hover:bg-neutral-100"
      }`}
    >
      {children}
    </button>
  );
}

export function ControlBar(props: ControlBarProps) {
  const citySize = useUiStore((state) => state.citySize);
  const trafficLevel = useUiStore((state) => state.trafficLevel);
  const controller = useUiStore((state) => state.controller);
  const seed = useUiStore((state) => state.seed);
  const running = useUiStore((state) => state.running);
  const ready = useUiStore((state) => state.ready);
  const runComplete = useUiStore((state) => state.runComplete);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-xl border border-neutral-900/10 bg-white/85 px-3 py-2 shadow-sm backdrop-blur-sm">
        <Segmented
          label="City"
          options={CITY_SIZES}
          value={citySize}
          onChange={props.onCitySize}
        />
        <Segmented
          label="Traffic"
          options={TRAFFIC_LEVELS}
          value={trafficLevel}
          onChange={props.onTrafficLevel}
        />
        <Segmented
          label="Controller"
          options={CONTROLLERS}
          value={controller}
          onChange={props.onController}
        />
        <div className="hidden h-5 w-px bg-neutral-900/10 sm:block" />
        <div className="flex items-center gap-1.5">
          <ActionButton
            primary
            onClick={props.onStart}
            disabled={!ready || running || runComplete}
          >
            Start
          </ActionButton>
          <ActionButton onClick={props.onPause} disabled={!ready || !running}>
            Pause
          </ActionButton>
          <ActionButton onClick={props.onRestart} disabled={!ready}>
            Restart
          </ActionButton>
          <ActionButton onClick={props.onNewSeed} disabled={!ready}>
            New Seed
          </ActionButton>
        </div>
        <span className="text-[10px] tabular-nums tracking-wide text-neutral-400">
          seed {seed}
          {runComplete ? " · complete" : running ? "" : " · paused"}
        </span>
      </div>
    </div>
  );
}
