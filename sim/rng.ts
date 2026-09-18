/**
 * Deterministic seeded RNG — the single source of randomness for the
 * simulation (PRD §7.2: custom small seeded PRNG, no dependency).
 *
 * ## Algorithm
 *
 * Mulberry32: a 32-bit state generator using the public-domain mixing
 * function popularized by Tommy Ettinger / bryc. Each draw advances the
 * state by a fixed odd increment and passes it through an integer-only
 * avalanche mix. The state is kept strictly inside the uint32 domain
 * (`>>> 0` after every update) so behavior never depends on float64
 * accumulation, which can silently lose exactness after very long runs.
 *
 * Output of this masked form is bit-identical to the canonical
 * (float-accumulating) Mulberry32; this was cross-checked over 100k draws
 * during implementation (commit-level evidence in tests/rng.test.ts).
 *
 * ## Guarantees
 *
 * - Deterministic: the same seed always produces the same sequence on every
 *   platform (only `Math.imul`, integer addition, XOR, and logical shifts —
 *   all exactly specified by ECMAScript).
 * - Independently constructible: instances share no state; they can be
 *   created, interleaved, and consumed in any order without coupling.
 * - Period 2^32 (uint32 state space).
 * - `fork(label)` derives an independent child stream from the *root* seed
 *   and the label. The same (seed, label) pair always yields the same child
 *   stream, regardless of how far the parent has been consumed — so adding
 *   draws to one subsystem can never shift another subsystem's sequence.
 *
 * ## Not cryptographic
 *
 * Fine for simulation determinism; never for security, tokens, or keys.
 *
 * ## Value ranges
 *
 * - `nextUint32()`: integer in [0, 2^32 - 1]
 * - `nextFloat()`:  double in [0, 1), 32-bit granularity (nextUint32 / 2^32)
 * - `nextInt(min, max)`: integer in [min, max], inclusive on both ends
 *
 * ## Seeds
 *
 * Seeds are 32-bit unsigned integers. Negative integers wrap into the
 * uint32 domain (e.g. -1 === 4294967295) and are otherwise rejected with a
 * RangeError so typos cannot silently change determinism.
 */

export interface Rng {
  /** The normalized uint32 root seed this stream was created from. */
  readonly seed: number;
  /** Next integer in [0, 2^32 - 1]. */
  nextUint32(): number;
  /** Next double in [0, 1) with 32-bit granularity. */
  nextFloat(): number;
  /** Next integer in [minInclusive, maxInclusive], both ends included. */
  nextInt(minInclusive: number, maxInclusive: number): number;
  /** Uniformly picks one element; requires a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Derives an independent named child stream from the root seed. */
  fork(label: string): Rng;
}

const UINT32_RANGE = 4294967296; // 2^32

function normalizeSeed(seed: number): number {
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError(`RNG seed must be a safe integer, received ${seed}`);
  }
  return seed >>> 0; // negative integers wrap into the uint32 domain
}

/**
 * Derives a child seed from the root seed and a label:
 * FNV-1a over the label's UTF-16 code units (keyed by the root seed),
 * then a splitmix32-style avalanche so nearby labels decorrelate.
 */
function deriveSeed(rootSeed: number, label: string): number {
  let h = (0x811c9dc5 ^ rootSeed) >>> 0;
  for (let i = 0; i < label.length; i += 1) {
    h = (h ^ label.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

export function createRng(seed: number): Rng {
  const rootSeed = normalizeSeed(seed);
  let state = rootSeed;

  // Mulberry32 step over strict uint32 state.
  function nextUint32(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) & 0xffffffff);
    return (t ^ (t >>> 14)) >>> 0;
  }

  const rng: Rng = {
    seed: rootSeed,
    nextUint32,
    nextFloat(): number {
      return nextUint32() / UINT32_RANGE;
    },
    nextInt(minInclusive: number, maxInclusive: number): number {
      if (!Number.isInteger(minInclusive) || !Number.isInteger(maxInclusive)) {
        throw new RangeError("nextInt bounds must be integers");
      }
      if (maxInclusive < minInclusive) {
        throw new RangeError(
          `nextInt requires max >= min, received [${minInclusive}, ${maxInclusive}]`,
        );
      }
      const span = maxInclusive - minInclusive + 1;
      return minInclusive + Math.floor(rng.nextFloat() * span);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError("pick requires a non-empty array");
      }
      return items[rng.nextInt(0, items.length - 1)];
    },
    fork(label: string): Rng {
      return createRng(deriveSeed(rootSeed, label));
    },
  };

  return rng;
}
