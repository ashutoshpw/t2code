import { expect, it, vi } from "vite-plus/test";
import { RetainedMediaVideoSource, type RetainedVideoPlayer } from "./mediaVideoSource";

function setup() {
  let current = true,
    holds = 0;
  const events = new Map<string, Set<(event: never) => void>>();
  const native = {
    currentTime: 0,
    duration: 100,
    playing: false,
    isPlaybackRequested: false,
    status: "readyToPlay",
    timeUpdateEventInterval: 0,
    replaceAsync: vi.fn(async (source: { uri: string }) => {
      for (const listener of events.get("sourceLoad") ?? [])
        listener({ videoSource: source, duration: 100 } as never);
    }),
    pause: vi.fn(() => {
      native.playing = false;
      native.isPlaybackRequested = false;
    }),
    addListener: (event: string, listener: (event: never) => void) => {
      const list = events.get(event) ?? new Set();
      list.add(listener);
      events.set(event, list);
      return { remove: () => list.delete(listener) };
    },
  };
  const renew = vi.fn(async (_signal: AbortSignal) => "https://source/renewed");
  const owner = new RetainedMediaVideoSource({
    current: () => current,
    initialUrl: () => "https://source/initial",
    renew,
    hold: () => {
      holds++;
      return () => {
        holds--;
      };
    },
  });
  const player: RetainedVideoPlayer = native;
  const stop = owner.attach(player);
  const play = vi.fn(async () => {
    native.playing = true;
    native.isPlaybackRequested = true;
  });
  const sample = (time: number, requested: boolean, playing = requested) => {
    const changed = native.isPlaybackRequested !== requested;
    native.currentTime = time;
    native.playing = playing;
    native.isPlaybackRequested = requested;
    if (changed)
      for (const listener of events.get("playbackRequestedChange") ?? [])
        listener({ isPlaybackRequested: requested } as never);
    if (native.timeUpdateEventInterval > 0)
      for (const listener of events.get("timeUpdate") ?? []) listener({} as never);
  };
  return {
    owner,
    native,
    player,
    play,
    stop,
    renew,
    sample,
    get holds() {
      return holds;
    },
    loaded: (uri: string) => {
      for (const listener of events.get("sourceLoad") ?? [])
        listener({ videoSource: { uri }, duration: 100 } as never);
    },
    invalidate: () => {
      current = false;
    },
  };
}
it("restores seek/play intent across renewal and honors user pause/seek during signing and retained state after native error", async () => {
  const h = setup();
  await h.owner.load(h.player, new AbortController().signal, h.play, h.native.pause);
  expect(h.play).not.toHaveBeenCalled();
  h.sample(37, true);
  const signature = Promise.withResolvers<string>();
  h.renew.mockImplementationOnce(() => signature.promise);
  const pending = h.owner.load(h.player, new AbortController().signal, h.play, h.native.pause);
  h.sample(42, false);
  signature.resolve("https://source/new");
  await pending;
  expect(h.native.currentTime).toBe(42);
  expect(h.play).not.toHaveBeenCalled();
  h.sample(51, true, false);
  h.sample(63, true, false);
  h.native.status = "error";
  h.native.currentTime = 0;
  h.native.playing = false;
  await h.owner.load(h.player, new AbortController().signal, h.play, h.native.pause);
  expect(h.native.currentTime).toBe(63);
  expect(h.play).toHaveBeenCalledTimes(1);
  h.stop();
  expect(h.holds).toBe(0);
});
it("keeps its decoder hold until pending replace ends and refuses stale seek/play on close or source invalidation", async () => {
  for (const mode of ["close", "source"]) {
    const h = setup();
    h.sample(37, true);
    const replacement = Promise.withResolvers<void>();
    h.native.replaceAsync.mockImplementationOnce(() => replacement.promise);
    const pending = h.owner.load(h.player, new AbortController().signal, h.play, h.native.pause);
    expect(h.holds).toBe(1);
    if (mode === "close") h.stop();
    else h.invalidate();
    expect(h.holds).toBe(1);
    h.native.currentTime = 0;
    replacement.resolve();
    h.loaded("https://source/initial");
    await pending;
    expect(h.play).not.toHaveBeenCalled();
    expect(h.native.currentTime).toBe(0);
    h.stop();
    expect(h.holds).toBe(0);
  }
});
it("uses the playback interruption gate after seeking and never seeks an aborted replacement", async () => {
  const h = setup();
  h.sample(37, true);
  await h.owner.load(h.player, new AbortController().signal, async () => {}, h.native.pause);
  expect(h.native.currentTime).toBe(37);
  expect(h.play).not.toHaveBeenCalled();
  const signature = Promise.withResolvers<string>();
  h.renew.mockImplementationOnce(() => signature.promise);
  const abort = new AbortController();
  const pending = h.owner.load(h.player, abort.signal, h.play, h.native.pause);
  abort.abort();
  signature.resolve("https://source/canceled");
  await pending;
  expect(h.native.replaceAsync).toHaveBeenCalledTimes(1);
  h.stop();
});

it("honors explicit Pause during native source replacement before restoring play intent", async () => {
  const h = setup();
  h.sample(37, true);
  const replacement = Promise.withResolvers<void>();
  h.native.replaceAsync.mockImplementationOnce(() => replacement.promise);
  const pause = vi.fn(() => h.native.pause());
  const pending = h.owner.load(h.player, new AbortController().signal, h.play, pause);
  h.owner.pause();
  expect(pause).toHaveBeenCalledTimes(2);
  replacement.resolve();
  h.loaded("https://source/initial");
  await pending;
  expect(h.native.currentTime).toBe(37);
  expect(h.play).not.toHaveBeenCalled();
  h.stop();
});
