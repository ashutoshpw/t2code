/**
 * A box a stable callback reads at call time. It is written from an effect after each commit, so
 * handlers see the newest props without the callback being re-created.
 */
export class Latest<T> {
  #value: T;

  constructor(initial: T) {
    this.#value = initial;
  }

  set(next: T): void {
    this.#value = next;
  }

  get(): T {
    return this.#value;
  }
}
