// Tests for SampleRingBuffer — fixed-capacity ring buffer for trace samples.

import { describe, it, expect } from 'vitest';
import { SampleRingBuffer } from '../src/lib/circuit/sample-ring-buffer';

describe('SampleRingBuffer', () => {
  it('starts empty', () => {
    const rb = new SampleRingBuffer(10);
    expect(rb.length).toBe(0);
    expect(rb.isFull).toBe(false);
    expect(rb.last()).toBeNull();
  });

  it('pushes samples and grows length', () => {
    const rb = new SampleRingBuffer(10);
    rb.push(0, 1);
    rb.push(0.1, 2);
    rb.push(0.2, 3);
    expect(rb.length).toBe(3);
    expect(rb.isFull).toBe(false);
  });

  it('returns the last sample via last()', () => {
    const rb = new SampleRingBuffer(10);
    rb.push(0, 1);
    rb.push(0.1, 2);
    rb.push(0.2, 3);
    const last = rb.last();
    expect(last).not.toBeNull();
    expect(last!.time).toBe(0.2);
    expect(last!.voltage).toBe(3);
  });

  it('wraps around when full, overwriting oldest sample', () => {
    const rb = new SampleRingBuffer(3);
    rb.push(0, 10);
    rb.push(1, 20);
    rb.push(2, 30);
    expect(rb.length).toBe(3);
    expect(rb.isFull).toBe(true);
    // Push one more — should overwrite the oldest (0, 10)
    rb.push(3, 40);
    expect(rb.length).toBe(3);
    // The oldest is now (1, 20)
    expect(rb.timeAt(0)).toBe(1);
    expect(rb.voltageAt(0)).toBe(20);
    // The newest is (3, 40)
    expect(rb.last()!.time).toBe(3);
    expect(rb.last()!.voltage).toBe(40);
  });

  it('forEach iterates in chronological order (oldest first)', () => {
    const rb = new SampleRingBuffer(5);
    rb.push(1, 10);
    rb.push(2, 20);
    rb.push(3, 30);
    const seen: number[] = [];
    rb.forEach((_t, v) => seen.push(v));
    expect(seen).toEqual([10, 20, 30]);
  });

  it('forEach iterates in chronological order after wrap', () => {
    const rb = new SampleRingBuffer(3);
    rb.push(1, 10);
    rb.push(2, 20);
    rb.push(3, 30);
    rb.push(4, 40);  // overwrites (1, 10)
    rb.push(5, 50);  // overwrites (2, 20)
    const seen: { t: number; v: number }[] = [];
    rb.forEach((t, v) => seen.push({ t, v }));
    // Oldest should now be (3, 30), then (4, 40), then (5, 50)
    expect(seen).toEqual([
      { t: 3, v: 30 },
      { t: 4, v: 40 },
      { t: 5, v: 50 },
    ]);
  });

  it('timeAt / voltageAt return NaN for out-of-range indices', () => {
    const rb = new SampleRingBuffer(5);
    rb.push(0, 1);
    expect(rb.timeAt(0)).toBe(0);
    expect(rb.voltageAt(0)).toBe(1);
    expect(rb.timeAt(1)).toBeNaN();
    expect(rb.voltageAt(-1)).toBeNaN();
  });

  it('toArray produces a chronological snapshot', () => {
    const rb = new SampleRingBuffer(4);
    rb.push(0, 1);
    rb.push(1, 2);
    rb.push(2, 3);
    const arr = rb.toArray();
    expect(arr.length).toBe(3);
    expect(arr[0]).toEqual({ time: 0, voltage: 1 });
    expect(arr[2]).toEqual({ time: 2, voltage: 3 });
  });

  it('toArray works after wrap', () => {
    const rb = new SampleRingBuffer(3);
    rb.push(0, 1);
    rb.push(1, 2);
    rb.push(2, 3);
    rb.push(3, 4);  // overwrites (0, 1)
    const arr = rb.toArray();
    expect(arr.length).toBe(3);
    expect(arr[0]).toEqual({ time: 1, voltage: 2 });
    expect(arr[2]).toEqual({ time: 3, voltage: 4 });
  });

  it('clear() resets the buffer', () => {
    const rb = new SampleRingBuffer(5);
    rb.push(0, 1);
    rb.push(1, 2);
    expect(rb.length).toBe(2);
    rb.clear();
    expect(rb.length).toBe(0);
    expect(rb.isFull).toBe(false);
    expect(rb.last()).toBeNull();
  });

  it('handles capacity of 2 (minimum)', () => {
    const rb = new SampleRingBuffer(2);
    rb.push(0, 1);
    rb.push(1, 2);
    rb.push(2, 3);
    expect(rb.length).toBe(2);
    expect(rb.last()!.voltage).toBe(3);
  });

  it('handles fractional / negative voltages', () => {
    const rb = new SampleRingBuffer(5);
    rb.push(0, -1.5);
    rb.push(0.1, 0);
    rb.push(0.2, 3.14159);
    expect(rb.voltageAt(0)).toBe(-1.5);
    expect(rb.voltageAt(2)).toBeCloseTo(3.14159, 5);
  });

  it('forEach passes the chronological index (0-based)', () => {
    const rb = new SampleRingBuffer(4);
    rb.push(10, 100);
    rb.push(20, 200);
    rb.push(30, 300);
    const indices: number[] = [];
    rb.forEach(() => indices.push(indices.length));
    expect(indices).toEqual([0, 1, 2]);
  });

  it('maxCapacity reflects the configured capacity', () => {
    const rb = new SampleRingBuffer(500);
    expect(rb.maxCapacity).toBe(500);
  });

  it('forEach on empty buffer is a no-op', () => {
    const rb = new SampleRingBuffer(5);
    let count = 0;
    rb.forEach(() => count++);
    expect(count).toBe(0);
  });

  it('handles large capacity (1000 samples)', () => {
    const rb = new SampleRingBuffer(1000);
    for (let i = 0; i < 1500; i++) {
      rb.push(i * 0.001, i * 0.01);
    }
    expect(rb.length).toBe(1000);
    expect(rb.isFull).toBe(true);
    // Oldest should be sample 500 (after 500 overwrites)
    expect(rb.timeAt(0)).toBe(0.5);
    expect(rb.voltageAt(0)).toBe(5);
    // Newest should be sample 1499
    expect(rb.last()!.time).toBeCloseTo(1.499, 5);
    expect(rb.last()!.voltage).toBeCloseTo(14.99, 5);
  });
});
