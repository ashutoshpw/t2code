import { expect, it } from "vite-plus/test";
import { SpaceHeavyMediaSource } from "./heavyMedia.ts";
import { SpaceImagePreviewBudget } from "./imagePreview.ts";

function video(src: string, time = 0, paused = true) {
  const calls: string[] = [];
  const element = {
    src,
    currentSrc: src,
    currentTime: time,
    duration: 120,
    paused,
    error: null as unknown,
    pause() {
      calls.push("pause");
      this.paused = true;
    },
    async play() {
      calls.push("play");
      this.paused = false;
    },
    removeAttribute(name: string) {
      calls.push(`remove:${name}`);
      if (name === "src") this.src = "";
    },
    load() {
      calls.push("load");
    },
  };
  return { element, calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("shares one heavy PDF/video lease across views and reacquires only after release", () => {
  const budget = new SpaceImagePreviewBudget();
  const pdf = budget.watchHeavy(),
    player = budget.watchHeavy();
  const closePdf = pdf.subscribe(() => {});
  const anotherReader = pdf.subscribe(() => {});
  const closePlayer = player.subscribe(() => {});
  expect(pdf.getSnapshot().active).toBe(true);
  expect(player.getSnapshot().active).toBe(false);
  closePdf();
  player.retry();
  expect(player.getSnapshot().active).toBe(false);
  anotherReader();
  player.retry();
  expect(player.getSnapshot().active).toBe(true);
  closePlayer();
  const reconnect = pdf.subscribe(() => {});
  expect(pdf.getSnapshot().active).toBe(true);
  reconnect();
});
it.each([true, false])(
  "renews a video at its captured time and paused state (%s), rejecting stale metadata",
  async (paused) => {
    const owner = new SpaceHeavyMediaSource(() => true);
    const stop = owner.subscribe(() => {});
    const first = video("first", 37, paused);
    const attempt = owner.getSnapshot().attempt;
    owner.attach(first.element, attempt, "first");
    owner.loaded(first.element, attempt, "first");
    await owner.retry(async () => "renewed");
    const next = video("renewed");
    owner.loaded(first.element, attempt, "first");
    owner.attach(next.element, owner.getSnapshot().attempt, "renewed");
    owner.loaded(next.element, owner.getSnapshot().attempt, "renewed");
    expect(next.element.currentTime).toBe(37);
    expect(next.element.paused).toBe(paused);
    expect(first.calls.slice(-3)).toEqual(["pause", "remove:src", "load"]);
    stop();
    expect(next.calls.slice(-3)).toEqual(["pause", "remove:src", "load"]);
  },
);
it("tears down an active source and ignores held renewal across reconnect or authority loss without unhandled work", async () => {
  let current = true;
  const owner = new SpaceHeavyMediaSource(() => current);
  const stop = owner.subscribe(() => {});
  const element = video("old", 23, false);
  owner.attach(element.element, owner.getSnapshot().attempt, "old");
  owner.loaded(element.element, owner.getSnapshot().attempt, "old");
  const reply = deferred<string>();
  const renewal = owner.retry(() => reply.promise);
  const rejection = expect(renewal).rejects.toThrow("changed");
  await expect(owner.retry(async () => "duplicate")).rejects.toThrow("already active");
  stop();
  const next = owner.subscribe(() => {});
  reply.resolve("late");
  await rejection;
  expect(owner.getSnapshot().url).toBeNull();
  expect(element.calls.slice(-3)).toEqual(["pause", "remove:src", "load"]);
  current = false;
  await expect(owner.retry(async () => "forbidden")).rejects.toThrow("no longer current");
  next();
});

it("retains the last playback position through a failed source and failed remint without restarting at zero", async () => {
  const owner = new SpaceHeavyMediaSource(() => true);
  const stop = owner.subscribe(() => {});
  const first = video("old", 49, false);
  owner.attach(first.element, owner.getSnapshot().attempt, "old");
  owner.loaded(first.element, owner.getSnapshot().attempt, "old");
  owner.remember(first.element, owner.getSnapshot().attempt);
  first.element.error = new Error("Expired source");
  first.element.currentTime = 0;
  first.element.paused = true;
  await expect(
    owner.retry(async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  await owner.retry(async () => "new");
  const next = video("new");
  owner.attach(next.element, owner.getSnapshot().attempt, "new");
  owner.loaded(next.element, owner.getSnapshot().attempt, "new");
  expect(next.element.currentTime).toBe(49);
  expect(next.element.paused).toBe(false);
  stop();
});

it("keeps the bounded PDF page anchor across URL retry and subscription reacquisition", async () => {
  const owner = new SpaceHeavyMediaSource(() => true);
  const stop = owner.subscribe(() => {});
  owner.rememberPage(731);
  await owner.retry(async () => "signed-pdf");
  expect(owner.getPage()).toBe(731);
  owner.rememberPage(2000);
  expect(owner.getPage()).toBe(731);
  stop();
  owner.rememberPage(0);
  expect(owner.getPage()).toBe(731);
  const resumed = owner.subscribe(() => {});
  expect(owner.getPage()).toBe(731);
  resumed();
});

it("owns the video before metadata and releases only its exact element, including strict ref reacquisition", () => {
  const owner = new SpaceHeavyMediaSource(() => true);
  const stop = owner.subscribe(() => {});
  const first = video("first");
  const release = owner.attach(first.element, owner.getSnapshot().attempt, "first")!;
  release();
  expect(first.calls).toEqual(["pause", "remove:src", "load"]);
  expect(first.element.src).toBe("");
  const releaseAgain = owner.attach(first.element, owner.getSnapshot().attempt, "first")!;
  expect(first.element.src).toBe("first");
  release();
  expect(first.element.src).toBe("first");
  const second = video("second");
  owner.attach(second.element, owner.getSnapshot().attempt, "second");
  releaseAgain();
  owner.loaded(first.element, owner.getSnapshot().attempt, "first");
  expect(second.calls).toEqual([]);
  stop();
  expect(second.calls).toEqual(["pause", "remove:src", "load"]);
});
