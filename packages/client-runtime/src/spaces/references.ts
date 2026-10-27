import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceCapability,
  SpaceReferenceResolveInput,
  SpaceReferenceResolveResult,
  SpaceSearchInput,
  SpaceSearchResult,
} from "@t2code/contracts/spaces";
import type { SpacePageNavigationTarget } from "./navigation.ts";

type Capability =
  | (Pick<SpaceCapability, "version" | "features"> & Partial<Pick<SpaceCapability, "limits">>)
  | undefined;
function supportsSpaceMethod(capability: Capability, method: "search" | "referenceResolution") {
  return capability?.version === 2 && capability.features?.[method] === true;
}
export interface SpaceReferenceAccess {
  readonly session: object | null;
  readonly sourceVersion: number;
  readonly canRead: boolean;
  readonly capability: Capability;
}
export type SpaceSearchWindow =
  | {
      readonly status:
        | "idle"
        | "invalid-query"
        | "unsupported"
        | "unavailable"
        | "building"
        | "error";
    }
  | {
      readonly status: "ready";
      readonly query: string;
      readonly result: SpaceSearchResult;
      readonly current: () => boolean;
      readonly target: (index: number) => SpaceReferenceResolveInput["target"] | null;
      readonly next: () => Promise<SpaceSearchWindow>;
    };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

class LatestSourceRead<A> {
  private active:
    | {
        read: () => Promise<A | null>;
        resolve: (value: A | null) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  private pending: LatestSourceRead<A>["active"];

  cancel() {
    this.active?.resolve(null);
    this.pending?.resolve(null);
    this.pending = undefined;
  }

  submit(read: () => Promise<A | null>): Promise<A | null> {
    this.cancel();
    return new Promise((resolve, reject) => {
      const job = { read, resolve, reject };
      if (this.active) this.pending = job;
      else this.run(job);
    });
  }

  private run(job: NonNullable<LatestSourceRead<A>["active"]>) {
    this.active = job;
    void (async () => {
      try {
        job.resolve(await job.read());
      } catch (error) {
        job.reject(error);
      } finally {
        this.active = undefined;
        const next = this.pending;
        this.pending = undefined;
        if (next) this.run(next);
      }
    })();
  }
}

export class SpaceReferenceController {
  private generation = 0;
  private resolutionGeneration = 0;
  private readonly searches = new LatestSourceRead<SpaceSearchResult>();
  private readonly resolutions = new LatestSourceRead<SpaceReferenceResolveResult>();
  private disposed = false;
  private readonly options: {
    environmentId: EnvironmentId;
    access: () => SpaceReferenceAccess;
    search: (input: SpaceSearchInput) => Promise<SpaceSearchResult>;
    resolve: (input: SpaceReferenceResolveInput) => Promise<SpaceReferenceResolveResult>;
  };
  private readonly session: object | null;
  private readonly sourceVersion: number;
  constructor(options: SpaceReferenceController["options"]) {
    this.options = options;
    const access = options.access();
    this.session = access.session;
    this.sourceVersion = access.sourceVersion;
  }
  current() {
    const access = this.options.access();
    return (
      !this.disposed &&
      access.sourceVersion === this.sourceVersion &&
      access.session !== null &&
      access.session === this.session &&
      access.canRead &&
      (access.capability?.version === 1 || access.capability?.version === 2)
    );
  }
  canResolve() {
    return (
      this.current() && supportsSpaceMethod(this.options.access().capability, "referenceResolution")
    );
  }

  private owner(method: "search" | "referenceResolution") {
    return () => this.current() && supportsSpaceMethod(this.options.access().capability, method);
  }

  invalidate() {
    this.generation++;
    this.resolutionGeneration++;
    this.searches.cancel();
    this.resolutions.cancel();
  }
  dispose() {
    this.disposed = true;
    this.invalidate();
  }
  async search(query: string): Promise<SpaceSearchWindow> {
    const generation = ++this.generation;
    this.searches.cancel();
    if (query.length > 254) return { status: "invalid-query" };
    if (!query.trim()) return { status: "idle" };
    const limits = this.options.access().capability?.limits?.search;
    if (
      bytes(query) > Math.min(256, limits?.maxQueryBytes ?? 256) ||
      query.trim().split(/\s+/u).length > Math.min(8, limits?.maxTerms ?? 8)
    )
      return { status: "invalid-query" };
    return this.readWindow(query, undefined, generation);
  }
  private async readWindow(
    query: string,
    cursor: SpaceSearchInput["cursor"],
    generation: number,
  ): Promise<SpaceSearchWindow> {
    const owner = this.owner("search");
    const limits = this.options.access().capability?.limits?.search;
    const rows = Math.min(20, limits?.maxRows ?? 20);
    const maximum = Math.min(32768, limits?.maxResponseBytes ?? 32768);
    const current = () => generation === this.generation && owner();
    if (!current()) return { status: "unsupported" };
    try {
      const result = await this.searches.submit(async () =>
        current()
          ? this.options.search({
              environmentId: this.options.environmentId,
              query,
              limit: rows,
              ...(cursor ? { cursor } : {}),
            })
          : null,
      );
      if (!current() || !result || result.items.length > rows || bytes(result) > maximum)
        return { status: "unavailable" };
      return {
        status: "ready",
        query,
        result,
        current,
        target: (index) => {
          const hit = result.items[index];
          return current() && hit
            ? hit.blockId
              ? { kind: "block", blockId: hit.blockId }
              : { kind: "page", pageId: hit.page.id }
            : null;
        },
        next: () =>
          current() && result.nextCursor
            ? this.readWindow(query, result.nextCursor, ++this.generation)
            : Promise.resolve({ status: "unavailable" }),
      };
    } catch (error) {
      if (!current()) return { status: "unavailable" };
      return {
        status:
          typeof error === "object" &&
          error !== null &&
          "reason" in error &&
          error.reason === "building"
            ? "building"
            : typeof error === "object" &&
                error !== null &&
                "reason" in error &&
                error.reason === "unsupported"
              ? "unsupported"
              : "error",
      };
    }
  }
  async resolve(target: SpaceReferenceResolveInput["target"]) {
    const owner = this.owner("referenceResolution");
    const generation = ++this.resolutionGeneration;
    this.resolutions.cancel();
    const currentOwner = () => owner() && generation === this.resolutionGeneration;
    if (!currentOwner()) return null;
    try {
      const result = await this.resolutions.submit(async () =>
        currentOwner()
          ? this.options.resolve({ environmentId: this.options.environmentId, target })
          : null,
      );
      if (
        !currentOwner() ||
        !result ||
        bytes(result) > 16384 ||
        (result.status !== "resolved" && result.status !== "merged")
      )
        return null;
      if (
        result.page.trash ||
        (target.kind === "page"
          ? result.status !== "resolved" ||
            result.page.id !== target.pageId ||
            result.blockId !== undefined
          : result.status === "merged"
            ? result.requestedBlockId !== target.blockId
            : result.blockId !== target.blockId)
      )
        return null;
      const location: SpacePageNavigationTarget = {
        environmentId: this.options.environmentId,
        spaceId: result.page.spaceId,
        pageId: result.page.id,
        ...(result.blockId ? { blockId: result.blockId } : {}),
      };
      return {
        page: result.page,
        status: result.status,
        current: () => (currentOwner() ? location : null),
      };
    } catch {
      return null;
    }
  }
}
