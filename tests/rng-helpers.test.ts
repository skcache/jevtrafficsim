import { describe, expect, it } from "vitest";
import { createRng, type Rng } from "@/sim/rng";

function draw(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, () => rng.nextUint32());
}

describe("RNG output ranges", () => {
  it("keeps nextUint32 within [0, 2^32)", () => {
    const rng = createRng(99);
    let violations = 0;
    for (let i = 0; i < 10000; i += 1) {
      const value = rng.nextUint32();
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        violations += 1;
      }
    }
    expect(violations).toBe(0);
  });

  it("keeps nextFloat within [0, 1)", () => {
    const rng = createRng(100);
    let violations = 0;
    for (let i = 0; i < 10000; i += 1) {
      const value = rng.nextFloat();
      if (value < 0 || value >= 1) {
        violations += 1;
      }
    }
    expect(violations).toBe(0);
  });

  it("derives nextFloat exactly as nextUint32 / 2^32", () => {
    const floats = createRng(2024);
    const ints = createRng(2024);
    for (let i = 0; i < 100; i += 1) {
      expect(floats.nextFloat() * 4294967296).toBe(ints.nextUint32());
    }
  });

  it("matches the frozen golden first float for seed 42", () => {
    expect(createRng(42).nextFloat()).toBe(0.6011037519201636);
  });

  it("keeps nextInt within inclusive bounds and reaches every value", () => {
    const rng = createRng(1234);
    const seen = new Set<number>();
    let violations = 0;
    for (let i = 0; i < 10000; i += 1) {
      const value = rng.nextInt(3, 9);
      if (!Number.isInteger(value) || value < 3 || value > 9) {
        violations += 1;
      }
      seen.add(value);
    }
    expect(violations).toBe(0);
    expect(seen).toEqual(new Set([3, 4, 5, 6, 7, 8, 9]));
  });

  it("returns the only value for a single-value range", () => {
    const rng = createRng(5);
    for (let i = 0; i < 100; i += 1) {
      expect(rng.nextInt(5, 5)).toBe(5);
    }
  });

  it("rejects invalid nextInt ranges and bounds", () => {
    const rng = createRng(1);
    expect(() => rng.nextInt(5, 4)).toThrow(RangeError);
    expect(() => rng.nextInt(0.5, 3)).toThrow(RangeError);
    expect(() => rng.nextInt(3, 5.5)).toThrow(RangeError);
  });
});

describe("RNG pick helper", () => {
  it("returns a member of the array, deterministically", () => {
    const items = ["a", "b", "c", "d"];
    const a = createRng(31);
    const b = createRng(31);
    for (let i = 0; i < 100; i += 1) {
      const picked = a.pick(items);
      expect(picked).toBe(b.pick(items));
      expect(items).toContain(picked);
    }
  });

  it("rejects empty arrays", () => {
    expect(() => createRng(1).pick([])).toThrow(RangeError);
  });
});

describe("RNG fork streams", () => {
  it("derives a stable stream for the same root seed and label", () => {
    expect(draw(createRng(42).fork("city"), 8)).toEqual(
      draw(createRng(42).fork("city"), 8),
    );
  });

  it("matches the frozen golden fork streams for seed 42", () => {
    expect(draw(createRng(42).fork("city"), 3)).toEqual([
      3658372313, 1945890768, 7339233,
    ]);
    expect(draw(createRng(42).fork("traffic"), 3)).toEqual([
      1625484653, 3663293631, 887761743,
    ]);
  });

  it("does not disturb the parent stream", () => {
    const parent = createRng(42);
    parent.fork("city");
    parent.fork("traffic");
    expect(draw(parent, 10)).toEqual(draw(createRng(42), 10));
  });

  it("derives the same fork stream regardless of when it is created", () => {
    const root = createRng(42);
    const early = root.fork("city");
    for (let i = 0; i < 25; i += 1) {
      root.nextUint32();
    }
    const late = root.fork("city");
    expect(draw(early, 8)).toEqual(draw(late, 8));
  });

  it("derives different streams for different labels", () => {
    expect(draw(createRng(42).fork("city"), 8)).not.toEqual(
      draw(createRng(42).fork("traffic"), 8),
    );
  });

  it("derives different streams for different root seeds", () => {
    expect(draw(createRng(1).fork("city"), 8)).not.toEqual(
      draw(createRng(2).fork("city"), 8),
    );
  });
});
