"use client";

/**
 * Shared onboarding / scenario controls (Task 11 polish pass): one slider, one
 * segmented control and one seed field used by both the configuration surface
 * and the live scenario popover, so the product keeps a single control
 * vocabulary. Presentational only — parents own the values.
 */
import { Slider } from "radix-ui";
import { motion } from "motion/react";
import type { ReactNode } from "react";

export function DiscreteSlider({
  value,
  count,
  onChange,
  ariaLabel,
}: {
  value: number;
  count: number;
  onChange: (index: number) => void;
  ariaLabel: string;
}) {
  return (
    <Slider.Root
      className="relative flex h-5 w-full touch-none select-none items-center"
      min={0}
      max={count - 1}
      step={1}
      value={[value]}
      onValueChange={([next]) => onChange(next)}
      aria-label={ariaLabel}
    >
      <Slider.Track className="relative h-[3px] grow rounded-full bg-ink/10">
        <Slider.Range className="absolute h-full rounded-full bg-ink" />
      </Slider.Track>
      <Slider.Thumb className="block h-4 w-4 rounded-full border border-ink/15 bg-surface shadow-resting transition-transform duration-150 hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/20 active:scale-110" />
    </Slider.Root>
  );
}

/**
 * Tick labels aligned to the thumb's travel (0% … 100% of the track), not to
 * equal-width columns — the first and last labels hug the ends.
 */
export function TickRow({
  labels,
  value,
  onSelect,
}: {
  labels: readonly string[];
  value: number;
  onSelect?: (index: number) => void;
}) {
  return (
    <div className="relative mt-2 h-4">
      {labels.map((label, index) => {
        const last = index === labels.length - 1;
        const position = (index / (labels.length - 1)) * 100;
        return (
          <button
            key={label}
            type="button"
            tabIndex={onSelect ? 0 : -1}
            onClick={onSelect ? () => onSelect(index) : undefined}
            className={`absolute top-0 text-micro font-medium uppercase tracking-[0.08em] transition-colors ${
              index === value ? "text-ink" : "text-ink-38"
            } ${onSelect ? "cursor-pointer hover:text-ink-70" : "cursor-default"}`}
            style={{
              left: `${position}%`,
              transform: last ? "translateX(-100%)" : index === 0 ? "none" : "translateX(-50%)",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  layoutId,
  height = 32,
  ariaLabel,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  layoutId: string;
  height?: number;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="relative flex rounded-[7px] bg-ink/[0.05] p-[3px]"
      style={{ height }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={`relative flex min-w-[76px] items-center justify-center rounded-[6px] px-3 text-meta font-medium transition-colors ${
              selected ? "text-ink" : "text-ink-52 hover:text-ink-70"
            }`}
          >
            {selected && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-[6px] bg-surface shadow-resting"
                transition={{ type: "spring", stiffness: 520, damping: 40 }}
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Five-pip die, drawn rather than typed — the dingbat glyph read as a bug. */
function DieGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="5" r="1.15" fill="currentColor" />
      <circle cx="11" cy="5" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="5" cy="11" r="1.15" fill="currentColor" />
      <circle cx="11" cy="11" r="1.15" fill="currentColor" />
    </svg>
  );
}

export function SeedField({
  text,
  onText,
  onCommit,
  onRoll,
  rotation,
  label,
}: {
  text: string;
  onText: (text: string) => void;
  onCommit: () => void;
  onRoll: () => void;
  /** Accumulating rotation (degrees) so the die keeps spinning forward. */
  rotation: number;
  label?: ReactNode;
}) {
  return (
    <div>
      {label}
      <div className="relative flex items-center">
        <input
          value={text}
          onChange={(event) => onText(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onCommit();
            }
          }}
          inputMode="numeric"
          aria-label="Seed"
          className="value-num h-9 w-full rounded-control border border-hair bg-surface pl-3 pr-11 text-ui text-ink outline-none transition-colors focus:border-ink/25"
        />
        <button
          type="button"
          onClick={onRoll}
          aria-label="Random seed"
          title="Random seed"
          className="absolute right-1 flex h-7 w-7 items-center justify-center rounded-[6px] text-ink-52 transition-colors hover:bg-ink/[0.05] hover:text-ink active:scale-95"
        >
          <motion.span
            animate={{ rotate: rotation }}
            transition={{ type: "spring", stiffness: 260, damping: 22 }}
            className="flex"
          >
            <DieGlyph />
          </motion.span>
        </button>
      </div>
    </div>
  );
}
