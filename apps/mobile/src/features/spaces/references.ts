import {
  type SpacePageNavigationTarget,
  SpaceReferenceController,
  type SpaceReferenceAccess,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceReferenceResolveInput } from "@t2code/contracts/spaces";

export async function createMobileSpaceReferenceController(options: {
  environmentId: EnvironmentId;
  captureSession: () => Promise<() => object | null>;
  access: () => Omit<SpaceReferenceAccess, "session">;
  search: ConstructorParameters<typeof SpaceReferenceController>[0]["search"];
  resolve: ConstructorParameters<typeof SpaceReferenceController>[0]["resolve"];
}) {
  const session = await options.captureSession();
  const inlineContext = options.access().inlineContext;
  return new SpaceReferenceController({
    ...options,
    access: () => {
      const access = options.access();
      return { ...access, session: access.inlineContext === inlineContext ? session() : null };
    },
  });
}

export interface MobileSpaceReference {
  readonly environmentId: EnvironmentId;
  readonly target: SpaceReferenceResolveInput["target"];
}

export class MobileSpaceReferenceNavigation {
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #disposed = false;
  #owner: SpaceReferenceController | null = null;
  #sourceCurrent: () => boolean = () => false;
  #snapshot: {
    selection: MobileSpaceReference | null;
    busy: boolean;
    error: string | null;
    title: string | null;
  } = { selection: null, busy: false, error: null, title: null };

  constructor(
    readonly ports: {
      current: () => boolean;
      open: (target: SpacePageNavigationTarget) => void;
    },
  ) {}
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #update(patch: Partial<ReturnType<MobileSpaceReferenceNavigation["getSnapshot"]>>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
  select(selection: MobileSpaceReference, current: () => boolean) {
    if (this.#disposed || !this.ports.current() || !current()) return;
    this.#generation++;
    this.#owner?.invalidate();
    this.#sourceCurrent = current;
    this.#update({ selection, busy: false, error: null, title: null });
  }
  async open(owner: SpaceReferenceController, environmentId: EnvironmentId) {
    const selection = this.#snapshot.selection;
    if (!selection || this.#disposed) return;
    const generation = ++this.#generation;
    this.#owner?.invalidate();
    if (
      environmentId !== selection.environmentId ||
      !this.ports.current() ||
      !this.#sourceCurrent() ||
      !owner.canResolve()
    ) {
      this.#update({
        busy: false,
        error: "Current-source opening requires live read access and reference resolution.",
      });
      return;
    }
    this.#owner = owner;
    this.#update({ busy: true, error: null });
    const result = await owner.resolve(selection.target);
    if (this.#disposed || generation !== this.#generation || this.#snapshot.selection !== selection)
      return;
    const destination = result?.current();
    if (
      !result ||
      !destination ||
      destination.environmentId !== selection.environmentId ||
      !this.ports.current() ||
      !this.#sourceCurrent()
    ) {
      this.#update({
        busy: false,
        error:
          "Current source is stale, deleted, in trash or unavailable. The reference is retained.",
      });
      return;
    }
    this.#update({
      busy: false,
      title: `${result.page.icon ? `${result.page.icon} ` : ""}${result.page.title || "Untitled page"}`,
    });
    this.ports.open(destination);
  }
  mount() {
    this.#disposed = false;
    return () => this.dispose();
  }
  dispose() {
    this.#disposed = true;
    this.#generation++;
    this.#owner?.invalidate();
  }
}
