import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export interface ChangeHubSpec<Batch, Box, Event> {
  readonly empty: () => Box;
  readonly isEmpty: (batch: Batch) => boolean;
  /** Folds a batch into a subscriber's mailbox and collapses it to an overflow marker when it grows too large. */
  readonly merge: (box: Box, batch: Batch) => void;
  /** Takes and clears a mailbox into events. */
  readonly take: (box: Box) => ReadonlyArray<Event>;
  readonly resync: Event;
}

export interface ChangeHub<Batch, Event> {
  /** Never waits, so a slow subscriber cannot hold the write lock. */
  readonly publish: (batch: Batch) => Effect.Effect<void>;
  /** Emits `resync` first, then the events each subscriber's mailbox collected. */
  readonly subscribe: Stream.Stream<Event>;
}

export const makeChangeHub = <Batch, Box, Event>(
  spec: ChangeHubSpec<Batch, Box, Event>,
): ChangeHub<Batch, Event> => {
  interface Subscriber {
    readonly signal: Queue.Queue<void>;
    readonly box: Box;
  }
  const subscribers = new Set<Subscriber>();
  const publish = (batch: Batch) =>
    Effect.sync(() => {
      if (spec.isEmpty(batch)) return;
      for (const subscriber of subscribers) {
        spec.merge(subscriber.box, batch);
        Queue.offerUnsafe(subscriber.signal, undefined);
      }
    });
  const subscribe = Stream.unwrap(
    Effect.gen(function* () {
      const signal = yield* Queue.sliding<void>(1);
      const subscriber: Subscriber = { signal, box: spec.empty() };
      yield* Effect.acquireRelease(
        Effect.sync(() => void subscribers.add(subscriber)),
        () => Effect.sync(() => void subscribers.delete(subscriber)),
      );
      const rest = Stream.fromEffectRepeat(
        Queue.take(signal).pipe(Effect.map(() => spec.take(subscriber.box))),
      ).pipe(Stream.flatMap((events) => Stream.fromArray(events)));
      return Stream.concat(Stream.make<[Event]>(spec.resync), rest);
    }),
  );
  return { publish, subscribe };
};
