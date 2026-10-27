import type { AssetCreateUrlResult } from "@t2code/contracts";
import type {
  SpaceAssetId,
  SpaceAssetMetadata,
  SpaceBlock,
  SpaceCapability,
} from "@t2code/contracts/spaces";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";

export class MobileSpaceImageBudget {
  #owner: object | null = null;
  acquire() {
    if (this.#owner)
      throw new Error("Close the other Spaces image first, or wait for its request to finish.");
    const token = {};
    this.#owner = token;
    return () => {
      if (this.#owner === token) this.#owner = null;
    };
  }
}
export interface MobileSpaceMediaAccess {
  readonly capability: SpaceCapability | undefined;
  readonly httpBaseUrl: string;
  readonly current: () => boolean;
}
export class MobileSpaceImageViewer {
  readonly #listeners = new Set<() => void>();
  #release: (() => void) | null = null;
  #abort: AbortController | null = null;
  #inFlight = false;
  #generation = 0;
  #sourceCurrent: () => boolean = () => false;
  #snapshot: {
    assetId: SpaceAssetId | null;
    metadata: SpaceAssetMetadata | null;
    url: string | null;
    expiresAt: number;
    busy: boolean;
    error: string | null;
  } = { assetId: null, metadata: null, url: null, expiresAt: 0, busy: false, error: null };
  constructor(
    readonly ports: {
      budget: MobileSpaceImageBudget;
      access: () => MobileSpaceMediaAccess;
      now: () => number;
      metadata: (assetId: SpaceAssetId, signal: AbortSignal) => Promise<SpaceAssetMetadata>;
      mint: (
        assetId: SpaceAssetId,
        disposition: "inline" | "attachment",
        signal: AbortSignal,
      ) => Promise<AssetCreateUrlResult>;
      share: (input: {
        url: string;
        metadata: SpaceAssetMetadata;
        signal: AbortSignal;
        current: () => boolean;
      }) => Promise<void>;
    },
  ) {}
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(patch: Partial<ReturnType<MobileSpaceImageViewer["getSnapshot"]>>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  #access() {
    const access = this.ports.access(),
      capability = access.capability;
    if (
      !this.#sourceCurrent() ||
      !access.current() ||
      capability?.version !== 2 ||
      capability.features?.assets !== true ||
      !capability.limits.assets
    )
      throw new Error(
        "Images require a current source, assets support and destination read permission.",
      );
    return { ...access, limits: capability.limits.assets };
  }
  current() {
    try {
      this.#access();
      return this.#snapshot.assetId !== null;
    } catch {
      return false;
    }
  }
  url() {
    return this.current() && this.#snapshot.expiresAt > this.ports.now()
      ? this.#snapshot.url
      : null;
  }
  async open(block: SpaceBlock, current: () => boolean) {
    if (this.#inFlight || this.#snapshot.assetId) return;
    try {
      if (!isKnownSpaceBlock(block) || block.type !== "image")
        throw new Error("This media is read-only; image preview is unavailable.");
      this.#sourceCurrent = current;
      this.#access();
      this.#release = this.ports.budget.acquire();
      this.#generation++;
      this.#update({ assetId: block.content.assetId, metadata: null, url: null, error: null });
      await this.refresh();
    } catch (cause) {
      this.#update({ error: cause instanceof Error ? cause.message : "Image unavailable" });
    }
  }
  async #run(share: boolean) {
    const assetId = this.#snapshot.assetId;
    if (this.#inFlight || !assetId) return;
    this.#inFlight = true;
    const generation = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#update({ busy: true, error: null });
    const current = () =>
      generation === this.#generation && !abort.signal.aborted && this.current();
    try {
      const access = this.#access();
      const metadata = await this.ports.metadata(assetId, abort.signal);
      if (!current() || !access.current()) return;
      const dimensions = metadata.imageDimensions;
      if (
        metadata.assetId !== assetId ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(metadata.mimeType) ||
        !Number.isSafeInteger(metadata.byteSize) ||
        metadata.byteSize < 1 ||
        metadata.byteSize > Math.min(10 * 1024 * 1024, access.limits.maxImageBytes) ||
        !dimensions ||
        !Number.isSafeInteger(dimensions.width) ||
        !Number.isSafeInteger(dimensions.height) ||
        dimensions.width < 1 ||
        dimensions.height < 1 ||
        dimensions.width * dimensions.height > Math.min(24_000_000, access.limits.maxImagePixels)
      )
        throw new Error("Image metadata exceeds the supported preview policy.");
      const signed = await this.ports.mint(assetId, share ? "attachment" : "inline", abort.signal);
      if (!current() || !access.current()) return;
      const url = new URL(signed.relativeUrl, access.httpBaseUrl),
        origin = new URL(access.httpBaseUrl);
      if (
        !signed.relativeUrl.startsWith("/api/assets/") ||
        signed.relativeUrl.startsWith("//") ||
        url.origin !== origin.origin ||
        !["http:", "https:"].includes(url.protocol) ||
        url.search ||
        url.hash ||
        signed.fileRevision !== metadata.digest ||
        !Number.isSafeInteger(signed.expiresAt) ||
        signed.expiresAt <= this.ports.now()
      )
        throw new Error(
          "The signed image source is expired or does not match this environment and original.",
        );
      if (share)
        await this.ports.share({
          url: url.href,
          metadata,
          signal: abort.signal,
          current: () => current() && access.current() && signed.expiresAt > this.ports.now(),
        });
      else this.#update({ metadata, url: url.href, expiresAt: signed.expiresAt });
    } catch (cause) {
      if (generation === this.#generation)
        this.#update({ error: cause instanceof Error ? cause.message : "Image unavailable" });
    } finally {
      this.#inFlight = false;
      if (this.#abort === abort) this.#abort = null;
      if (generation === this.#generation) this.#update({ busy: false });
      if (!this.#snapshot.assetId) {
        this.#release?.();
        this.#release = null;
      }
    }
  }
  refresh = () => this.#run(false);
  share = () => this.#run(true);
  failed(url: string) {
    if (this.#snapshot.url !== url || !this.current()) return;
    this.#update({
      url: null,
      error: "Image could not load. Refresh its signed URL or save the original.",
    });
  }
  close = () => {
    this.#generation++;
    this.#abort?.abort();
    this.#sourceCurrent = () => false;
    this.#update({
      assetId: null,
      metadata: null,
      url: null,
      expiresAt: 0,
      busy: false,
      error: null,
    });
    if (!this.#inFlight) {
      this.#release?.();
      this.#release = null;
    }
  };
}
