"use client";

/**
 * IncidentBar (Task 11 polish pass): the chaos dock.
 *
 * Five instruments in one hairline surface. Each button arms briefly on
 * click (ink fill), the reserved line above the dock reports what was queued
 * or, on hover, what the instrument does — so the dock never shifts height.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { IncidentKind } from "@/sim/incidents";
import { useUiStore } from "@/store/ui-store";

interface IncidentOption {
  readonly kind: IncidentKind;
  readonly label: string;
  readonly hint: string;
  readonly icon: () => React.JSX.Element;
}

const iconProps = {
  width: 12,
  height: 12,
  viewBox: "0 0 12 12",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const INCIDENTS: readonly IncidentOption[] = [
  {
    kind: "traffic-burst",
    label: "+5× Traffic",
    hint: "Multiply arrivals across the city",
    icon: () => (
      <svg {...iconProps}>
        <path d="M2.5 9.5 6 4.5l3.5 5" />
        <path d="M2.5 6.5 6 1.5l3.5 5" />
      </svg>
    ),
  },
  {
    kind: "crash",
    label: "Crash",
    hint: "Block the busiest approach",
    icon: () => (
      <svg {...iconProps}>
        <path d="M6 1.5v3.2M6 7.3v3.2M1.5 6h3.2M7.3 6h3.2" />
        <path d="M3 3l1.6 1.6M7.4 7.4 9 9M9 3 7.4 4.6M4.6 7.4 3 9" />
      </svg>
    ),
  },
  {
    kind: "close-road",
    label: "Close Road",
    hint: "Close a road and force rerouting",
    icon: () => (
      <svg {...iconProps}>
        <path d="M1.5 4.5h9M1.5 7.5h9" />
        <path d="M3.5 4.5v3M8.5 4.5v3" />
      </svg>
    ),
  },
  {
    kind: "bridge-closed",
    label: "Bridge Closed",
    hint: "Close a river crossing",
    icon: () => (
      <svg {...iconProps}>
        <path d="M1.5 8.5h9" />
        <path d="M1.5 8.5c2-3.4 7-3.4 9 0" />
        <path d="M6 4.6v3.9" />
      </svg>
    ),
  },
  {
    kind: "event-release",
    label: "Event Lets Out",
    hint: "Release a crowd onto the streets",
    icon: () => (
      <svg {...iconProps}>
        <path d="M2 6h5.5" />
        <path d="M5.5 3.5 8 6l-2.5 2.5" />
        <path d="M10 2.5v7" />
      </svg>
    ),
  },
];

const ARMED_MS = 600;
const FEEDBACK_MS = 2400;

export function IncidentBar({ onIncident }: { onIncident: (kind: IncidentKind) => void }) {
  const phase = useUiStore((state) => state.phase);
  const feedback = useUiStore((state) => state.feedback);
  const flashSurge = useUiStore((state) => state.flashSurge);
  const showSurge = useUiStore((state) => state.showSurge);
  const hideSurge = useUiStore((state) => state.hideSurge);
  const runComplete = useUiStore((state) => state.runComplete);
  const [armed, setArmed] = useState<IncidentKind | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  const fire = (option: IncidentOption) => {
    onIncident(option.kind);
    if (option.kind === "traffic-burst") {
      flashSurge();
      showSurge();
      timers.current.push(window.setTimeout(() => hideSurge(), 6000));
    }
    setArmed(option.kind);
    useUiStore.getState().setFeedback(`${option.label} queued`);
    timers.current.push(
      window.setTimeout(() => setArmed((current) => (current === option.kind ? null : current)), ARMED_MS),
      window.setTimeout(() => {
        const store = useUiStore.getState();
        if (store.feedback === `${option.label} queued`) {
          store.setFeedback(null);
        }
      }, FEEDBACK_MS),
    );
  };

  const live = phase === "city";
  // Queued feedback outranks the hover hint: after a click the cursor is
  // still on the button, and the confirmation is what matters.
  const line = feedback ?? hint;

  return (
    <motion.div
      className="pointer-events-none absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: live ? 1 : 0, y: live ? 0 : 8 }}
      transition={{ duration: 0.32, delay: live ? 0.12 : 0, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="surface pointer-events-auto flex flex-col p-[3px]">
        <div
          className="grid h-5 items-center px-2 text-micro font-medium text-ink-52"
          aria-live="polite"
        >
          <AnimatePresence mode="wait">
            {line && !runComplete && (
              <motion.span
                key={line}
                initial={{ opacity: 0, y: 2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="block truncate"
              >
                {line}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-[2px]">
          {INCIDENTS.map((option) => {
            const isArmed = armed === option.kind;
            const Icon = option.icon;
            return (
              <button
                key={option.kind}
                type="button"
                disabled={!live}
                onClick={() => fire(option)}
                onMouseEnter={() => setHint(option.hint)}
                onMouseLeave={() => setHint((current) => (current === option.hint ? null : current))}
                onFocus={() => setHint(option.hint)}
                onBlur={() => setHint((current) => (current === option.hint ? null : current))}
                className={`flex h-8 items-center gap-[6px] whitespace-nowrap rounded-[6px] px-2.5 text-meta font-medium transition-colors duration-150 ${
                  isArmed
                    ? "bg-ink text-surface"
                    : "text-ink-70 hover:bg-ink/[0.05] hover:text-ink"
                }`}
              >
                <Icon />
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
