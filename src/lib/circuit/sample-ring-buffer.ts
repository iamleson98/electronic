// Ring buffer for trace samples — replaces `array.slice(-max)` with a
// fixed-capacity Float64Array + write index. Avoids per-step GC allocations.
//
// Each trace has TWO ring buffers: one for time (seconds) and one for voltage
// (volts). They're written in lockstep so index `i` in both arrays refers to
// the same sample.
//
// Capacity is fixed at construction. Once full, new writes overwrite the
// oldest sample. `length` always reflects the number of valid samples
// (capacity minus unwritten slots at startup).
//
// Reads: callers can iterate `forEach(cb)` or fetch a snapshot via
// `toArray()`. Iteration order is chronological (oldest first).

export class SampleRingBuffer {
  private readonly times: Float64Array;
  private readonly voltages: Float64Array;
  private readonly capacity: number;
  private writeIdx = 0;
  private _length = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(2, Math.floor(capacity));
    this.times = new Float64Array(this.capacity);
    this.voltages = new Float64Array(this.capacity);
  }

  /** Push a single (time, voltage) sample. O(1). */
  push(time: number, voltage: number): void {
    this.times[this.writeIdx] = time;
    this.voltages[this.writeIdx] = voltage;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this._length < this.capacity) this._length++;
  }

  /** Number of valid samples currently in the buffer. */
  get length(): number {
    return this._length;
  }

  /** True if the buffer has wrapped (capacity filled at least once). */
  get isFull(): boolean {
    return this._length >= this.capacity;
  }

  /** Iterate over samples in chronological order (oldest first). O(n). */
  forEach(cb: (time: number, voltage: number, index: number) => void): void {
    const n = this._length;
    // If the buffer has wrapped, the oldest sample is at `writeIdx` (which is
    // about to be overwritten next). Otherwise, the oldest is at index 0.
    const start = this.isFull ? this.writeIdx : 0;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % this.capacity;
      cb(this.times[idx], this.voltages[idx], i);
    }
  }

  /** Get the time at chronological index `i` (0 = oldest). O(1). */
  timeAt(i: number): number {
    if (i < 0 || i >= this._length) return NaN;
    const start = this.isFull ? this.writeIdx : 0;
    return this.times[(start + i) % this.capacity];
  }

  /** Get the voltage at chronological index `i` (0 = oldest). O(1). */
  voltageAt(i: number): number {
    if (i < 0 || i >= this._length) return NaN;
    const start = this.isFull ? this.writeIdx : 0;
    return this.voltages[(start + i) % this.capacity];
  }

  /** Get the most-recent sample. O(1). Returns null if empty. */
  last(): { time: number; voltage: number } | null {
    if (this._length === 0) return null;
    const lastIdx = (this.writeIdx - 1 + this.capacity) % this.capacity;
    return { time: this.times[lastIdx], voltage: this.voltages[lastIdx] };
  }

  /**
   * Snapshot to plain arrays (for compatibility with code expecting
   * `samples: ProbeSample[]`). Allocates new arrays — call sparingly.
   */
  toArray(): { time: number; voltage: number }[] {
    const out: { time: number; voltage: number }[] = new Array(this._length);
    let i = 0;
    this.forEach((t, v) => {
      out[i] = { time: t, voltage: v };
      i++;
    });
    return out;
  }

  /** Clear all samples. O(1). */
  clear(): void {
    this.writeIdx = 0;
    this._length = 0;
  }

  /** Maximum number of samples this buffer can hold. */
  get maxCapacity(): number {
    return this.capacity;
  }
}
