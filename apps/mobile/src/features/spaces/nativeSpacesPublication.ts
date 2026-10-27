import type { SpaceBlock } from "@t2code/contracts/spaces";
import {
  applySpacesNativeSnapshot,
  nativeDocumentForSpaceBlock,
  receiveSpacesNativeSnapshot,
} from "./nativeSpacesAdapter";
import { decodeSpacesNativeSnapshot, type SpacesNativeSnapshot } from "./nativeSpacesProtocol";

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
    const initial = {
      ...document,
      composing: false,
      typing: document.runs[0] ?? { bold: false, italic: false, code: false },
    };
    this.#snapshot = { admitted: initial, observed: initial, blocked: false, error: null };
    this.#publishedRuns = JSON.stringify(document.runs);
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
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
