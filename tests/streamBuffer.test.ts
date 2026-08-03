import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStreamTextBuffer } from '@/lib/api/stream-buffer';

describe('createStreamTextBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches rapid appends into a single UI update', () => {
    const updates: string[] = [];
    const buf = createStreamTextBuffer((text) => updates.push(text), { intervalMs: 80 });

    buf.append('a');
    buf.append('b');
    buf.append('c');
    expect(updates).toEqual([]);

    vi.advanceTimersByTime(80);
    expect(updates).toEqual(['abc']);
    expect(buf.getText()).toBe('abc');

    buf.dispose();
  });

  it('flush emits immediately and clears the pending timer', () => {
    const updates: string[] = [];
    const buf = createStreamTextBuffer((text) => updates.push(text), { intervalMs: 80 });

    buf.append('hello');
    buf.flush();
    expect(updates).toEqual(['hello']);

    vi.advanceTimersByTime(80);
    expect(updates).toEqual(['hello']);

    buf.dispose();
  });

  it('dispose prevents further updates', () => {
    const updates: string[] = [];
    const buf = createStreamTextBuffer((text) => updates.push(text), { intervalMs: 80 });

    buf.append('x');
    buf.dispose();
    vi.advanceTimersByTime(80);
    expect(updates).toEqual([]);

    buf.append('y');
    buf.flush();
    expect(updates).toEqual([]);
  });
});
