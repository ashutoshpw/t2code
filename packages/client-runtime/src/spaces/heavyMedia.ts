interface VideoSurface {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly currentSrc: string;
  src: string;
  readonly error?: unknown;
  pause(): void;
  play(): Promise<void>;
  removeAttribute(name: string): void;
  load(): void;
}
interface SourceSnapshot {
  readonly active: boolean;
  readonly url: string | null;
  readonly attempt: number;
  readonly busy: boolean;
  readonly error: unknown;
}
export class SpaceHeavyMediaSource {
  readonly #listeners = new Set<() => void>();
  readonly #current: () => boolean;
  #snapshot: SourceSnapshot = { active: false, url: null, attempt: 0, busy: false, error: null };
  #video: VideoSurface | null = null;
  #resume: { time: number; paused: boolean } | null = null;
  #last: { time: number; paused: boolean } | null = null;
  #page = 0;
  getPage = () => this.#page;
  rememberPage = (page: number) => {
    if (this.current() && Number.isSafeInteger(page) && page >= 0 && page < 2000) this.#page = page;
  };
  #binding = 0;
  #loadedBinding = 0;
  #request = 0;
  constructor(current: () => boolean) {
    this.#current = current;
  }
  getSnapshot = () => this.#snapshot;
  #update(patch: Partial<SourceSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    if (!this.#snapshot.active) this.#update({ active: true, attempt: this.#snapshot.attempt + 1 });
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size) return;
      this.#request++;
      this.#capture();
      const video = this.#video;
      this.#video = null;
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      this.#snapshot = { ...this.#snapshot, active: false, busy: false, url: null };
    };
  };
  current() {
    return this.#snapshot.active && this.#current();
  }
  remember(video: VideoSurface, attempt: number) {
    if (
      !this.current() ||
      attempt !== this.#snapshot.attempt ||
      video !== this.#video ||
      this.#loadedBinding !== this.#binding ||
      video.error ||
      !Number.isFinite(video.currentTime)
    )
      return;
    this.#last = { time: Math.max(0, video.currentTime), paused: video.paused };
  }
  #capture() {
    if (this.#video && this.#loadedBinding === this.#binding) {
      if (!this.#video.error && Number.isFinite(this.#video.currentTime))
        this.#resume = { time: Math.max(0, this.#video.currentTime), paused: this.#video.paused };
      else this.#resume = this.#last ?? this.#resume;
    } else this.#resume ??= this.#last;
  }
  adoptUrl(url: string) {
    if (this.current() && this.#snapshot.url === null) this.#update({ url });
  }
  bindVideo = (video: VideoSurface) => {
    const { url, attempt } = this.#snapshot;
    if (!url) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      return;
    }
    return this.attach(video, attempt, url);
  };
  attach(video: VideoSurface, attempt: number, url: string) {
    if (!this.current() || attempt !== this.#snapshot.attempt) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      return;
    }
    if (this.#video && this.#video !== video) {
      this.#capture();
      const previous = this.#video;
      this.#video = null;
      previous.pause();
      previous.removeAttribute("src");
      previous.load();
    }
    if (video.src !== url) video.src = url;
    this.#video = video;
    const binding = ++this.#binding;
    return () => {
      if (this.#video !== video || this.#binding !== binding) return;
      this.#capture();
      this.#video = null;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }
  loaded(video: VideoSurface, attempt: number, url: string) {
    if (
      !this.current() ||
      attempt !== this.#snapshot.attempt ||
      video.currentSrc !== url ||
      this.#video !== video
    )
      return;
    this.#loadedBinding = this.#binding;
    const resume = this.#resume;
    if (!resume) {
      this.remember(video, attempt);
      return;
    }
    this.#resume = null;
    try {
      video.currentTime = Math.min(
        resume.time,
        Number.isFinite(video.duration) ? Math.max(0, video.duration) : resume.time,
      );
      this.#last = resume;
      if (resume.paused) video.pause();
      else
        void video.play().catch((error) => {
          if (this.#video === video && this.current()) this.#update({ error });
        });
    } catch (error) {
      this.#update({ error });
    }
  }
  async retry(refresh: () => Promise<string | null>) {
    if (!this.current()) throw new Error("Media source is no longer current");
    if (this.#snapshot.busy) throw new Error("A media URL refresh is already active");
    const request = ++this.#request;
    this.#capture();
    this.#video?.pause();
    this.#update({ busy: true, error: null });
    try {
      const url = await refresh();
      if (request !== this.#request || !this.current())
        throw new Error("Media source changed during URL refresh");
      if (!url) throw new Error("Media URL unavailable");
      const old = this.#video;
      this.#video = null;
      this.#update({ url, attempt: this.#snapshot.attempt + 1 });
      if (old) {
        old.pause();
        old.removeAttribute("src");
        old.load();
      }
    } catch (error) {
      if (request === this.#request && this.current()) this.#update({ error });
      throw error;
    } finally {
      if (request === this.#request) this.#update({ busy: false });
    }
  }
}
