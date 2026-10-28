import type { SpacePageTreeRow } from "./SpacePageTree.logic";

interface SpacePageFocusList {
  rows: () => readonly SpacePageTreeRow[];
  scrollToItem: (item: SpacePageTreeRow) => Promise<void>;
  cancelScroll: () => void;
  containsFocus: () => boolean;
  focus: (key: string, last: boolean) => void;
}

export class SpacePageFocusOwner {
  #list: SpacePageFocusList | null = null;
  #request = 0;
  #intent: { key: string; last: boolean } | null = null;
  readonly #options;

  constructor(options: { epoch: () => unknown; pending: (key: string | null) => void }) {
    this.#options = options;
  }

  attach = (list: SpacePageFocusList | null) => {
    this.cancel();
    this.#list = list;
  };

  invalidate = () => {
    if (!this.#intent) return;
    this.#request++;
    this.#list?.cancelScroll();
  };

  cancel = () => {
    this.invalidate();
    this.#intent = null;
    this.#options.pending(null);
  };

  request = (key: string, last = false) => {
    this.cancel();
    this.#intent = { key, last };
    this.#options.pending(key);
    return this.#run();
  };

  revalidate = (epoch: unknown, data: readonly SpacePageTreeRow[]) =>
    this.#intent && epoch === this.#options.epoch() && data === this.#list?.rows()
      ? this.#run()
      : Promise.resolve();

  async #run() {
    const list = this.#list;
    const intent = this.#intent;
    if (!list || !intent) return;
    const data = list.rows();
    const item = data.find((row) => row.key === intent.key);
    if (!item || !list.containsFocus()) {
      this.cancel();
      return;
    }
    const epoch = this.#options.epoch();
    const request = ++this.#request;
    await list.scrollToItem(item);
    if (
      request !== this.#request ||
      list !== this.#list ||
      intent !== this.#intent ||
      epoch !== this.#options.epoch() ||
      data !== list.rows() ||
      !list.containsFocus()
    )
      return;
    this.#intent = null;
    this.#options.pending(null);
    list.focus(intent.key, intent.last);
  }
}
