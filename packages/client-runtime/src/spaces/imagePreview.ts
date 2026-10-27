export class SpaceImagePreviewBudget {
  readonly #leases = new Map<object, { pixels: number; enlarged: boolean }>();
  watch(pixels: number) {
    const listeners = new Set<() => void>();
    let lease: ReturnType<SpaceImagePreviewBudget["acquire"]> | null = null;
    let enlarged = false;
    let snapshot: { active: boolean; error: unknown } = { active: false, error: null };
    const admit = () => {
      if (lease || !listeners.size) return;
      try {
        lease = this.acquire(pixels);
        lease.enlarge(enlarged);
        snapshot = { active: true, error: null };
      } catch (error) {
        lease?.release();
        lease = null;
        snapshot = { active: false, error };
      }
      for (const listener of listeners) listener();
    };
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        admit();
        return () => {
          listeners.delete(listener);
          if (!listeners.size) {
            lease?.release();
            lease = null;
            snapshot = { active: false, error: null };
          }
        };
      },
      retry: admit,
      enlarge: (value: boolean) => {
        if (!lease) throw new Error("Image preview is not admitted");
        lease.enlarge(value);
        enlarged = value;
      },
    };
  }
  acquire(pixels: number) {
    if (
      !Number.isSafeInteger(pixels) ||
      pixels < 1 ||
      pixels > 24000000 ||
      this.#leases.size >= 4 ||
      [...this.#leases.values()].reduce((sum, item) => sum + item.pixels, 0) + pixels > 48000000
    )
      throw new Error(
        "Image preview budget reached (four images / 48 megapixels). Close another preview first.",
      );
    const token = {},
      item = { pixels, enlarged: false };
    this.#leases.set(token, item);
    return {
      current: () => this.#leases.has(token),
      enlarge: (value: boolean) => {
        if (!this.#leases.has(token)) throw new Error("Image preview was released");
        if (value && [...this.#leases.values()].some((other) => other !== item && other.enlarged))
          throw new Error("Only one enlarged image is admitted at a time");
        item.enlarged = value;
      },
      release: () => {
        this.#leases.delete(token);
      },
    };
  }
}
