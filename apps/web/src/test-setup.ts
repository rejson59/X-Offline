import 'fake-indexeddb/auto';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom nie ma kilku rzeczy, z których korzysta apka.
if (!AbortSignal.timeout) {
  AbortSignal.timeout = (ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return c.signal;
  };
}

if (!window.matchMedia) {
  // @ts-expect-error — uproszczony stub
  window.matchMedia = (q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}

beforeEach(() => {
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});
