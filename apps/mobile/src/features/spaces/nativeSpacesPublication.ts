import type { SpaceBlock } from "@t2code/contracts/spaces";
import {
  applySpacesNativeSnapshot,
  nativeDocumentForSpaceBlock,
  receiveSpacesNativeSnapshot,
} from "./nativeSpacesAdapter";
import {
  decodeSpacesNativeSnapshot,
  type SpacesNativeMark,
  type SpacesNativeSnapshot,
} from "./nativeSpacesProtocol";

interface PublicationSnapshot {
  readonly admitted: SpacesNativeSnapshot;
  readonly observed: SpacesNativeSnapshot;
  readonly blocked: boolean;
  readonly error: string | null;
}

export class SpacesNativePublication {
  readonly #listeners = new Set<() => void>();
  readonly initialDocument;
  #publishedRuns: string;
  #snapshot: PublicationSnapshot;

  constructor(
    readonly block: SpaceBlock,
    readonly publish: (block: SpaceBlock) => void,
  ) {
    const document = nativeDocumentForSpaceBlock(block);
    if (!document) throw new Error("Block is read-only on mobile");
    this.initialDocument = document;
    const { text: _text, ...typing } = document.runs[0] ?? {
      text: "",
      bold: false,
      italic: false,
      code: false,
    };
    const initial = {
      ...document,
      composing: false,
      typing,
    };
    this.#snapshot = { admitted: initial, observed: initial, blocked: false, error: null };
    this.#publishedRuns = JSON.stringify(document.runs);
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  markState(mark: SpacesNativeMark): boolean | "mixed" {
    const current = this.#snapshot.observed;
    if (current.selection.start === current.selection.end) return current.typing[mark];
    let offset = 0;
    const selected = current.runs.filter((run) => {
      const start = offset;
      offset += run.text.length;
      return start < current.selection.end && offset > current.selection.start && offset > start;
    });
    const marked = selected.filter((run) => run[mark]).length;
    return marked === 0 ? false : marked === selected.length ? true : "mixed";
  }

  #commandRevision(expected: SpacesNativeSnapshot) {
    const current = this.#snapshot.observed;
    if (expected !== current)
      throw new Error("The native selection changed; try the command again");
    if (current.composing)
      throw new Error("Finish the current composition before changing formatting or history");
    decodeSpacesNativeSnapshot(current);
    return current.revision;
  }

  formatCommand(mark: SpacesNativeMark, expected: SpacesNativeSnapshot): string {
    if (!["bold", "italic", "code"].includes(mark))
      throw new Error("This mark is read-only on mobile");
    const revision = this.#commandRevision(expected);
    if (this.#snapshot.blocked)
      throw new Error("Recover the rejected native input before formatting");
    receiveSpacesNativeSnapshot(this.#snapshot.admitted, expected);
    return JSON.stringify({
      revision,
      selection: expected.selection,
      mark,
      enabled: this.markState(mark) !== true,
    });
  }

  historyRevision(expected: SpacesNativeSnapshot): number {
    return this.#commandRevision(expected);
  }
  #update(patch: Partial<PublicationSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  receive(value: unknown, change: boolean) {
    try {
      const observed = decodeSpacesNativeSnapshot(value);
      const previous = this.#snapshot.observed;
      if (observed.revision < previous.revision) return;
      if (
        observed.revision === previous.revision &&
        JSON.stringify(observed.runs) !== JSON.stringify(previous.runs)
      )
        throw new Error("Native content changed without a new revision");
      this.#update({ observed });
      const admitted = receiveSpacesNativeSnapshot(this.#snapshot.admitted, observed);
      if (change && !admitted.composing) {
        const runs = JSON.stringify(admitted.runs);
        if (runs !== this.#publishedRuns) {
          this.publish(applySpacesNativeSnapshot(this.block, admitted));
          this.#publishedRuns = runs;
        }
        this.#update({ admitted, blocked: false, error: null });
      } else {
        this.#update({ admitted });
      }
    } catch (cause) {
      this.#update({
        blocked: true,
        error: cause instanceof Error ? cause.message : "Native editor rejected this change",
      });
    }
  }
}
