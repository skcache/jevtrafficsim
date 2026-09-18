"use client";

/**
 * IncidentBar (Task 11): the five chaos controls. Sends INCIDENT commands;
 * the worker schedules them at the current simulation time through the
 * Task-10 engine seam. No target selectors, no modals, no incident logic in
 * React — only a short "queued" acknowledgement.
 */
import { useEffect, useRef, useState } from "react";
import type { IncidentKind } from "@/sim/incidents";
import { useUiStore } from "@/store/ui-store";

const INCIDENTS: readonly { kind: IncidentKind; label: string }[] = [
  { kind: "traffic-burst", label: "+5× Traffic" },
  { kind: "crash", label: "Crash" },
  { kind: "close-road", label: "Close Road" },
  { kind: "bridge-closed", label: "Bridge Closed" },
  { kind: "event-release", label: "Event Lets Out" },
];

export function IncidentBar({ onIncident }: { onIncident: (kind: IncidentKind) => void }) {
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
    timerRef.current = setTimeout(() => setQueued(null), 1_600);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1.5 rounded-xl border border-neutral-900/10 bg-white/85 px-3 py-2 shadow-sm backdrop-blur-sm">
        <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
          Incidents
        </span>
        {INCIDENTS.map((incident) => (
          <button
            key={incident.kind}
            type="button"
            disabled={disabled}
            onClick={() => fire(incident.kind, incident.label)}
            className="rounded-md border border-neutral-900/15 bg-white px-2.5 py-1 text-[11px] font-medium text-neutral-700 transition-colors hover:border-neutral-900 hover:bg-neutral-900 hover:text-white disabled:opacity-40"
          >
            {incident.label}
          </button>
        ))}
        <span
          aria-live="polite"
          className={`w-24 text-[10px] tracking-wide text-neutral-400 transition-opacity ${
            queued ? "opacity-100" : "opacity-0"
          }`}
        >
          {queued ? `queued · ${queued}` : ""}
        </span>
      </div>
    </div>
  );
}
