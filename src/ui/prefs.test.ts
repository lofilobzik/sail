import { describe, expect, it, vi } from 'vitest';
import { Preferences } from './prefs';

describe('Preferences', () => {
  it('starts from the defaults when storage is unavailable', () => {
    expect(new Preferences().value).toEqual({ volume: 0.7, muted: false, sail: null, guidesSeen: [], player: null });
  });

  it('merges a change and tells every subscriber', () => {
    const prefs = new Preferences();
    const a = vi.fn();
    const b = vi.fn();
    prefs.subscribe(a);
    prefs.subscribe(b);
    prefs.set({ muted: true });
    expect(prefs.value.muted).toBe(true);
    expect(prefs.value.volume).toBe(0.7);
    expect(a).toHaveBeenCalledWith(prefs.value);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
