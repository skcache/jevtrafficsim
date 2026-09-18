import { describe, expect, it } from "vitest";
import { BinaryHeap } from "@/sim/heap";
import { createRng } from "@/sim/rng";

describe("BinaryHeap", () => {
  it("pops items in ascending order for a min comparator", () => {
    const heap = new BinaryHeap<number>((a, b) => a - b);
    for (const value of [5, 3, 9, 1, 7, 1, 8, 2]) {
      heap.push(value);
    }
    const popped: number[] = [];
    while (!heap.isEmpty) {
      popped.push(heap.pop() as number);
    }
    expect(popped).toEqual([1, 1, 2, 3, 5, 7, 8, 9]);
  });

  it("supports custom comparators", () => {
    const heap = new BinaryHeap<string>(
      (a, b) => a.length - b.length || a.localeCompare(b),
    );
    for (const value of ["bbb", "a", "cc", "a", "ddddd"]) {
      heap.push(value);
    }
    expect(heap.pop()).toBe("a");
    expect(heap.pop()).toBe("a");
    expect(heap.pop()).toBe("cc");
    expect(heap.pop()).toBe("bbb");
    expect(heap.pop()).toBe("ddddd");
  });

  it("returns undefined when popping an empty heap", () => {
    const heap = new BinaryHeap<number>((a, b) => a - b);
    expect(heap.pop()).toBeUndefined();
    heap.push(1);
    expect(heap.pop()).toBe(1);
    expect(heap.pop()).toBeUndefined();
  });

  it("tracks size and emptiness through interleaved pushes and pops", () => {
    const heap = new BinaryHeap<number>((a, b) => a - b);
    expect(heap.size).toBe(0);
    expect(heap.isEmpty).toBe(true);
    heap.push(4);
    heap.push(2);
    heap.push(6);
    expect(heap.size).toBe(3);
    expect(heap.pop()).toBe(2);
    heap.push(1);
    expect(heap.size).toBe(3);
    expect(heap.pop()).toBe(1);
    expect(heap.pop()).toBe(4);
    expect(heap.pop()).toBe(6);
    expect(heap.isEmpty).toBe(true);
  });

  it("drains duplicate priorities completely", () => {
    const heap = new BinaryHeap<number>((a, b) => a - b);
    for (let i = 0; i < 5; i += 1) {
      heap.push(3);
    }
    const popped: number[] = [];
    while (!heap.isEmpty) {
      popped.push(heap.pop() as number);
    }
    expect(popped).toEqual([3, 3, 3, 3, 3]);
  });

  it("is deterministic for identical operation sequences", () => {
    const run = (): number[] => {
      const heap = new BinaryHeap<number>((a, b) => a - b);
      const rng = createRng(7);
      const out: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        heap.push(rng.nextInt(0, 20));
      }
      while (!heap.isEmpty) {
        out.push(heap.pop() as number);
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it("fully sorts a large deterministic input", () => {
    const heap = new BinaryHeap<number>((a, b) => a - b);
    const rng = createRng(99);
    const values = Array.from({ length: 1000 }, () => rng.nextInt(0, 9999));
    for (const value of values) {
      heap.push(value);
    }
    const popped: number[] = [];
    while (!heap.isEmpty) {
      popped.push(heap.pop() as number);
    }
    expect(popped).toEqual([...values].sort((a, b) => a - b));
  });
});
