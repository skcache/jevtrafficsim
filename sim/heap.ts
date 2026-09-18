/**
 * Minimal binary min-heap with a caller-supplied comparator.
 *
 * Comparator contract: `compare(a, b) < 0` means `a` should be popped before
 * `b`. Push and pop are O(log n). There is deliberately no decrease-key or
 * delete: A* pushes updated entries again and discards stale ones on pop,
 * which is simpler and fast enough at our graph sizes.
 *
 * `pop()` on an empty heap returns `undefined`.
 *
 * Determinism: the heap performs only array operations driven by the
 * comparator, so identical operation sequences always produce identical pop
 * orders. Ties are broken by the comparator itself — callers that need a
 * stable tie policy (such as A*) must encode it there.
 */

export type Comparator<T> = (a: T, b: T) => number;

export class BinaryHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: Comparator<T>) {}

  get size(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(item: T): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.items[index], this.items[parent]) < 0) {
        [this.items[index], this.items[parent]] = [
          this.items[parent],
          this.items[index],
        ];
        index = parent;
      } else {
        break;
      }
    }
  }

  pop(): T | undefined {
    const count = this.items.length;
    if (count === 0) {
      return undefined;
    }
    const top = this.items[0];
    const last = this.items.pop() as T;
    if (count > 1) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (
          left < this.items.length &&
          this.compare(this.items[left], this.items[smallest]) < 0
        ) {
          smallest = left;
        }
        if (
          right < this.items.length &&
          this.compare(this.items[right], this.items[smallest]) < 0
        ) {
          smallest = right;
        }
        if (smallest === index) {
          break;
        }
        [this.items[index], this.items[smallest]] = [
          this.items[smallest],
          this.items[index],
        ];
        index = smallest;
      }
    }
    return top;
  }
}
