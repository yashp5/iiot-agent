/** Fixed-capacity FIFO window over the telemetry stream, shared by layers 1 and 2. */
export class SlidingWindow<T> {
  private items: T[] = [];

  constructor(readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  /** Oldest first. */
  get values(): readonly T[] {
    return this.items;
  }

  get oldest(): T | undefined {
    return this.items[0];
  }

  get latest(): T | undefined {
    return this.items[this.items.length - 1];
  }

  clear(): void {
    this.items = [];
  }
}

export function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Population standard deviation — the window is the whole population of interest. */
export function stdDev(values: readonly number[], precomputedMean = mean(values)): number {
  const variance =
    values.reduce((sum, v) => sum + (v - precomputedMean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
