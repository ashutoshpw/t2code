import type { EnvironmentId } from "@t2code/contracts";
import { SpaceKnownMark, type SpaceReferenceResolveInput } from "@t2code/contracts/spaces";
import { Schema } from "effect";
import type { SpaceReferenceController, SpaceSearchWindow } from "@t2code/client-runtime/spaces";

export type SpaceMentionMark = Extract<SpaceKnownMark, { type: "page_mention" | "block_mention" }>;
export interface SpaceMentionSelection {
  readonly current: () => boolean;
  readonly insert: (mark: SpaceMentionMark, label: string) => boolean;
}
type Presentation =
  | { status: "resolved"; title: string }
  | { status: "unavailable" }
  | { status: "idle" };
const decode = Schema.decodeOption(SpaceKnownMark, { onExcessProperty: "error" });
export class SpaceMentionController {
  readonly #source: SpaceReferenceController;
  readonly #environmentId: EnvironmentId;
  readonly #current: () => boolean;
  readonly #titles = new Map<string, Presentation>();
  readonly #listeners = new Set<() => void>();
  #version = 0;
  constructor(
    source: SpaceReferenceController,
    environmentId: EnvironmentId,
    current: () => boolean = () => true,
  ) {
    this.#source = source;
    this.#environmentId = environmentId;
    this.#current = current;
  }
  current() {
    return this.#current() && this.#source.current();
  }
  supported() {
    return this.current() && this.#source.canSearch() && this.#source.canResolve();
  }
  getSnapshot = () => this.#version;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #target(mark: SpaceMentionMark): SpaceReferenceResolveInput["target"] | null {
    if (
      decode(mark)._tag !== "Some" ||
      !["page_mention", "block_mention"].includes(mark.type) ||
      mark.target.environmentId !== this.#environmentId
    )
      return null;
    return mark.type === "page_mention"
      ? { kind: "page", pageId: mark.target.pageId }
      : mark.type === "block_mention"
        ? { kind: "block", blockId: mark.target.blockId }
        : null;
  }
  canActivate(mark: SpaceMentionMark) {
    return this.current() && this.#source.canResolve() && !!this.#target(mark);
  }
  presentation(mark: SpaceMentionMark): Presentation {
    const target = this.#target(mark);
    return this.canActivate(mark) && target
      ? (this.#titles.get(JSON.stringify(target)) ?? { status: "idle" })
      : { status: "unavailable" };
  }
  async #resolve(target: SpaceReferenceResolveInput["target"]) {
    if (!this.current() || !this.#source.canResolve()) return null;
    const result = await this.#source.resolve(target);
    if (!this.current()) return null;
    const key = JSON.stringify(target),
      valid = result?.current();
    this.#titles.delete(key);
    this.#titles.set(
      key,
      valid && result && result.page.title.length <= 512
        ? { status: "resolved", title: result.page.title || "Untitled page" }
        : { status: "unavailable" },
    );
    if (this.#titles.size > 20) this.#titles.delete(this.#titles.keys().next().value!);
    this.#version++;
    for (const listener of this.#listeners) listener();
    return valid ? result : null;
  }
  async activate(mark: SpaceMentionMark) {
    const target = this.#target(mark);
    return target ? ((await this.#resolve(target))?.current() ?? null) : null;
  }
  search(query: string): Promise<SpaceSearchWindow> {
    return this.supported()
      ? this.#source.search(query)
      : Promise.resolve({ status: "unsupported" });
  }
  async choose(window: SpaceSearchWindow, index: number, selection: SpaceMentionSelection) {
    if (!this.supported() || !selection.current() || window.status !== "ready" || !window.current())
      return false;
    const target = window.target(index),
      hit = window.result.items[index];
    if (!target || !hit) return false;
    const result = await this.#resolve(target);
    if (!result?.current() || !this.supported() || !window.current() || !selection.current())
      return false;
    const mark: SpaceMentionMark =
      target.kind === "page"
        ? {
            type: "page_mention",
            version: 1,
            target: { environmentId: this.#environmentId, pageId: target.pageId },
          }
        : {
            type: "block_mention",
            version: 1,
            target: {
              environmentId: this.#environmentId,
              pageId: result.page.id,
              blockId: target.blockId,
            },
          };
    const label =
      target.kind === "block"
        ? hit.snippet || result.page.title || "Block"
        : result.page.title || "Untitled page";
    return selection.insert(mark, label);
  }
}
