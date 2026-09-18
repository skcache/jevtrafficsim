"use client";

/**
 * IncidentBar (Task 11 visual correction): the five chaos controls, styled as
 * intentional instruments rather than form buttons. Sends INCIDENT commands
 * through the Task-10 runtime seam; no incident logic in React.
 */
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { IncidentKind } from "@/sim/incidents";
import { useUiStore } from "@/store/ui-store";

const INCIDENTS: readonly { kind: IncidentKind; label: string; hint: string }[] = [
  { kind: "traffic-burst", label: "+5× Traffic", hint: "demand surge" },
  { kind: "crash", label: "Crash", hint: "lane blocked" },
  { kind: "close-road", label: "Close Road", hint: "reroutes" },
  { kind: "bridge-closed", label: "Bridge Closed", hint: "chokepoint" },
  { kind: "event-release", label: "Event Lets Out", hint: "arena surge" },
];

export function IncidentBar({ onIncident }: { onIncident: (kind: IncidentKind) => void }) {
  const phase = useUiStore((state) => state.phase);
  const ready = useUiStore((state) => state.ready);
  const runComplete = useUiStore((state) => state.runComplete);
  const [queued, setQueued] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  if (phase !== "city") {
    return null;
  }
  const disabled = !ready || runComplete;

  const fire = (kind: IncidentKind, label: string) => {
    if (disabled) {
      return;
    }
    onIncident(kind);
    setQueued(label);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => setQueued(null), 1_500);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-1.5 rounded-2xl border border-neutral-900/10 bg-white/85 px-2.5 py-2 shadow-sm backdrop-blur-sm">
        {INCIDENTS.map((incident) => (
          <motion.button
            key={incident.kind}
            type="button"
            title={incident.hint}
            disabled={disabled}
            onClick={() => fire(incident.kind, incident.label)}
            whileHover={disabled ? undefined : { y: -1 }}
            whileTap={disabled ? undefined : { scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            className="rounded-xl border border-neutral-900/10 bg-white px-3 py-1.5 text-[11px] font-medium tracking-wide text-neutral-700 transition-colors hover:border-neutral-900/30 hover:bg-neutral-900 hover:text-white disabled:opacity-40"
          >
            {incident.label}
          </motion.button>
        ))}
        <AnimatePresence>
          {queued && (
            <motion.span
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0 }}
              className="px-1 text-[10px] tracking-wide text-neutral-400"
            >
              queued · {queued}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
