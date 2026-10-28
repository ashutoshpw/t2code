import { describe, expect, it, vi } from "vite-plus/test";

import { createAutosave } from "./draftStore";

describe("createAutosave", () => {
  it("saves once after edits go idle", () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const autosave = createAutosave({ save, idleMs: 1000 });
    autosave.update(1);
    vi.advanceTimersByTime(600);
    autosave.update(2);
    vi.advanceTimersByTime(600);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not retry a failed attempt until the draft changes", async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {
      throw new Error("offline");
    });
    const autosave = createAutosave({ save, idleMs: 1000 });
    autosave.update(1);
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    autosave.update(1);
    vi.advanceTimersByTime(5000);
    expect(save).toHaveBeenCalledTimes(1);
    autosave.update(2);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("flushes a pending save immediately and cancels when nothing is wanted", () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const autosave = createAutosave({ save, idleMs: 1000 });
    autosave.update(1);
    autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    autosave.update(2);
    autosave.update(null);
    vi.advanceTimersByTime(2000);
    autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("retry saves now even after a failed attempt", () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => {});
    const autosave = createAutosave({ save, idleMs: 1000 });
    autosave.update(1);
    vi.advanceTimersByTime(1000);
    autosave.retry();
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
