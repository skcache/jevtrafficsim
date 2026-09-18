import { describe, expect, it } from "vitest";
import { createRng } from "@/sim/rng";

function drawUint32(seed: number, count: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, () => rng.nextUint32());
}

describe("RNG determinism", () => {
  it("produces identical sequences for identical seeds", () => {
    expect(drawUint32(42, 1000)).toEqual(drawUint32(42, 1000));
  });

  it("stays deterministic across independent interleaved instances", () => {
    const a = createRng(7);
    const b = createRng(7);
    const aValues: number[] = [];
    const bValues: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      aValues.push(a.nextUint32());
      bValues.push(b.nextUint32());
    }
    expect(aValues).toEqual(bValues);
  });

  it("diverges for different seeds", () => {
    const pairs: Array<[number, number]> = [
      [42, 43],
      [0, 1],
      [1337, 1338],
    ];
    for (const [first, second] of pairs) {
      expect(drawUint32(first, 1000)).not.toEqual(drawUint32(second, 1000));
    }
  });

  it("matches the frozen golden sequence for seed 42", () => {
    expect(drawUint32(42, 5)).toEqual([
      2581720956, 1925393290, 3661312704, 2876485805, 750819978,
    ]);
  });

  it("matches the frozen golden sequence for seed 123456789", () => {
    expect(drawUint32(123456789, 3)).toEqual([
      1107202814, 4169434471, 3372958138,
    ]);
  });

  it("normalizes negative seeds to their uint32 value", () => {
    expect(drawUint32(-1, 8)).toEqual(drawUint32(4294967295, 8));
  });

  it("rejects non-integer seeds", () => {
    expect(() => createRng(4.2)).toThrow(RangeError);
    expect(() => createRng(Number.NaN)).toThrow(RangeError);
    expect(() => createRng(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
