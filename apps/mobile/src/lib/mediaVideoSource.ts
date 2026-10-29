export interface RetainedVideoPlayer {
  readonly playing: boolean;
  readonly status: string;
  readonly duration: number;
  currentTime: number;
  timeUpdateEventInterval: number;
  replaceAsync(source: { uri: string; contentType: "progressive" }): Promise<void>;
  pause(): void;
  addListener(event: "timeUpdate" | "playingChange", listener: () => void): { remove(): void };
  addListener(
    event: "playbackRequestedChange",
    listener: (event: { isPlaybackRequested: boolean }) => void,
  ): { remove(): void };
  addListener(
    event: "sourceLoad",
    listener: (event: { videoSource: { uri?: string } | null; duration: number }) => void,
  ): { remove(): void };
  addListener(
    event: "statusChange",
    listener: (event: { status: string }) => void,
  ): { remove(): void };
}
export class RetainedMediaVideoSource {
  #player: RetainedVideoPlayer | null = null;
  #epoch = 0;
  #loading = false;
  #cancelReady: (() => void) | null = null;
  #replacing = false;
  #attempted = false;
  #intent: boolean | null = null;
  #pauseSerial = 0;
  #pausePlayback: (() => void) | null = null;
  #release: (() => void) | null = null;
  #last = { time: 0, play: false };
  constructor(
    readonly ports: {
      current: () => boolean;
      initialUrl: () => string | null;
      renew: (signal: AbortSignal) => Promise<string | null>;
      hold: () => () => void;
    },
  ) {}
  #capture(player: RetainedVideoPlayer) {
    if (this.#replacing || player !== this.#player || !this.ports.current()) return;
    try {
      if (
        player.status !== "error" &&
        Number.isFinite(player.currentTime) &&
        player.currentTime >= 0
      )
        this.#last = {
          time: player.currentTime,
          play: this.#intent ?? player.playing,
        };
    } catch {
      /* Native shared objects may already be released during unmount. */
    }
  }
  attach(player: RetainedVideoPlayer) {
    this.#player = player;
    const epoch = ++this.#epoch;
    const previousInterval = player.timeUpdateEventInterval;
    player.timeUpdateEventInterval = 1;
    const subscriptions = (["timeUpdate", "playingChange"] as const).map((event) =>
      player.addListener(event, () => this.#capture(player)),
    );
    subscriptions.push(
      player.addListener("playbackRequestedChange", (event) => {
        if (player !== this.#player || this.#replacing) return;
        try {
          if (player.status !== "error") this.#intent = event.isPlaybackRequested;
        } catch {
          return;
        }
        this.#capture(player);
      }),
    );
    return () => {
      if (epoch !== this.#epoch) return;
      this.#capture(player);
      this.#epoch++;
      this.#player = null;
      this.#cancelReady?.();
      for (const subscription of subscriptions) subscription.remove();
      try {
        player.timeUpdateEventInterval = previousInterval;
        player.pause();
      } catch {
        /* The native hook may release its object before this cleanup. */
      }
      if (!this.#loading) {
        this.#release?.();
        this.#release = null;
      }
    };
  }
  pause() {
    this.#pauseSerial++;
    this.#intent = false;
    this.#last = { ...this.#last, play: false };
    try {
      if (this.#player) {
        if (this.#pausePlayback) this.#pausePlayback();
        else this.#player.pause();
      }
    } catch {
      /* The player may be closing. */
    }
  }
  async load(
    player: RetainedVideoPlayer,
    signal: AbortSignal,
    play: () => Promise<void> | undefined,
    pause: () => void,
  ) {
    if (this.#loading || this.#player !== player || !this.ports.current())
      throw new Error("Wait for the previous video load or restore source access.");
    this.#release ??= this.ports.hold();
    this.#pausePlayback = pause;
    const epoch = this.#epoch;
    const current = () =>
      !signal.aborted && epoch === this.#epoch && this.#player === player && this.ports.current();
    this.#loading = true;
    try {
      this.#capture(player);
      const initial = !this.#attempted ? this.ports.initialUrl() : null;
      this.#attempted = true;
      const url = initial ?? (await this.ports.renew(signal));
      if (!current()) return;
      if (!url) throw new Error("The renewed video source is unavailable.");
      this.#capture(player);
      const resume = this.#last;
      const pauseSerial = this.#pauseSerial;
      this.#replacing = true;
      const ready = Promise.withResolvers<number | null>();
      const cancel = () => ready.resolve(null);
      this.#cancelReady = cancel;
      const loaded = player.addListener("sourceLoad", (event) => {
        if (event.videoSource?.uri === url) ready.resolve(event.duration);
      });
      const failed = player.addListener("statusChange", (event) => {
        if (event.status === "error") ready.resolve(null);
      });
      signal.addEventListener("abort", cancel, { once: true });
      try {
        pause();
        await player.replaceAsync({ uri: url, contentType: "progressive" });
        if (!current()) return;
        const duration = await ready.promise;
        if (!current()) return;
        if (duration === null) throw new Error("The renewed video source could not load.");
        player.currentTime =
          Number.isFinite(duration) && duration > 0 ? Math.min(resume.time, duration) : resume.time;
        if (resume.play && pauseSerial === this.#pauseSerial) await play();
        else pause();
      } finally {
        loaded.remove();
        failed.remove();
        signal.removeEventListener("abort", cancel);
        if (this.#cancelReady === cancel) this.#cancelReady = null;
      }
    } finally {
      this.#loading = false;
      this.#replacing = false;
      if (this.#player !== player) {
        this.#release?.();
        this.#release = null;
      }
    }
  }
}
