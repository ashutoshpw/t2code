export interface RateWindow {
  readonly ms: number;
  readonly max: number;
}
const FORM_RATE_WINDOWS: ReadonlyArray<RateWindow> = [
  { ms: 60_000, max: 5 },
  { ms: 3_600_000, max: 60 },
];
const FORM_RATE_MAX_KEYS = 1024;

export interface RateLimiter {
  admit(key: string, nowMs: number): boolean;
  size(): number;
}

interface Counter {
  start: number;
  count: number;
}

/** Fixed windows per key. The map never holds more than `maxKeys` keys. */
export function makeRateLimiter(
  windows: ReadonlyArray<RateWindow> = FORM_RATE_WINDOWS,
  maxKeys = FORM_RATE_MAX_KEYS,
): RateLimiter {
  const keys = new Map<string, Counter[]>();
  const longest = Math.max(...windows.map((window) => window.ms));
  const expired = (counters: readonly Counter[], nowMs: number) =>
    counters.every((counter, index) => nowMs - counter.start >= (windows[index]?.ms ?? longest));
  const makeRoom = (nowMs: number) => {
    for (const [key, counters] of keys) if (expired(counters, nowMs)) keys.delete(key);
    if (keys.size < maxKeys) return;
    const oldest = keys.keys().next();
    if (!oldest.done) keys.delete(oldest.value);
  };
  return {
    admit(key, nowMs) {
      let counters = keys.get(key);
      if (counters === undefined) {
        if (keys.size >= maxKeys) makeRoom(nowMs);
        counters = windows.map(() => ({ start: nowMs, count: 0 }));
        keys.set(key, counters);
      }
      counters.forEach((counter, index) => {
        if (nowMs - counter.start >= (windows[index]?.ms ?? longest)) {
          counter.start = nowMs;
          counter.count = 0;
        }
      });
      if (counters.some((counter, index) => counter.count >= (windows[index]?.max ?? 0)))
        return false;
      for (const counter of counters) counter.count++;
      return true;
    },
    size: () => keys.size,
  };
}
