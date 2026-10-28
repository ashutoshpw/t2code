export class PdfPosition {
  #page = 1;
  #epoch = 0;
  bind(current: () => boolean) {
    let epoch = -1;
    const valid = (pages: number) =>
      epoch === this.#epoch &&
      current() &&
      Number.isSafeInteger(pages) &&
      pages > 0 &&
      pages <= 2000;
    return {
      initialPage: this.#page,
      mount: () => {
        epoch = ++this.#epoch;
      },
      loaded: (pages: number) => valid(pages),
      current: () => epoch === this.#epoch && current(),
      pageChanged: (page: number, pages: number) => {
        if (
          epoch !== this.#epoch ||
          !current() ||
          !Number.isSafeInteger(pages) ||
          pages < 1 ||
          pages > 2000 ||
          !Number.isSafeInteger(page) ||
          page < 1 ||
          page > pages
        )
          return false;
        this.#page = page;
        return true;
      },
      dispose: () => {
        if (epoch === this.#epoch) this.#epoch++;
      },
    };
  }
}
