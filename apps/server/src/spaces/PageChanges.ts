import * as C from "@t2code/contracts/spaces";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { makeChangeHub } from "./ChangeHub.ts";
import * as SpacesSql from "./SpacesSql.ts";

/** A mailbox holding more entries than this collapses to `resync`, which bounds memory per subscriber. */
const MAILBOX_LIMIT = 512;
const EVENT_LIMIT = C.SPACE_PAGE_CHANGES_MAX_ENTRIES;

interface PageFlags {
  readonly tree?: true;
  readonly removed?: true;
}

export interface PageCollector {
  readonly pages: Map<string, { spaceId: string; tree: boolean; removed: boolean }>;
  readonly spaces: Set<string>;
}

export interface PageChangeBatch {
  readonly pages: ReadonlyArray<C.SpacePageChange>;
  readonly spaces: ReadonlyArray<string>;
}

/** The default collector is detached: records made outside a published transaction go nowhere. */
export const CurrentPageChangeCollector = Context.Reference<PageCollector | undefined>(
  "@t2code/cli/spaces/CurrentPageChangeCollector",
  { defaultValue: () => undefined },
);

export const makePageCollector = (): PageCollector => ({ pages: new Map(), spaces: new Set() });

export const recordPage = (pageId: string, spaceId: string, flags?: PageFlags) =>
  Effect.map(CurrentPageChangeCollector, (collector) => {
    if (collector === undefined) return;
    const held = collector.pages.get(pageId);
    collector.pages.set(pageId, {
      spaceId,
      tree: (held?.tree ?? false) || flags?.tree === true,
      removed: (held?.removed ?? false) || flags?.removed === true,
    });
  });

export const recordSpace = (spaceId: string) =>
  Effect.map(CurrentPageChangeCollector, (collector) => void collector?.spaces.add(spaceId));

/** Reads the committed revisions of what the collector recorded; removed or missing pages report zeros. */
export const resolve = Effect.fn("SpacesPageChanges.resolve")(function* (collector: PageCollector) {
  const sql = yield* SpacesSql.SpacesSql;
  const ids = [...collector.pages.keys()];
  const rows =
    ids.length === 0
      ? []
      : yield* sql<{
          readonly id: string;
          readonly spaceId: string;
          readonly revision: number;
          readonly bodyRevision: number;
        }>`SELECT page_id AS id, space_id AS spaceId, revision, body_revision AS bodyRevision
          FROM spaces_pages WHERE page_id IN ${sql.in(ids)}`;
  const found = new Map(rows.map((row) => [row.id, row]));
  const pages = ids.map((id): C.SpacePageChange => {
    const recorded = collector.pages.get(id)!;
    const row = found.get(id);
    const tree = recorded.tree ? { tree: true as const } : {};
    return row === undefined || recorded.removed
      ? {
          id: C.SpacePageId.make(id),
          spaceId: C.SpaceId.make(recorded.spaceId),
          revision: 0,
          bodyRevision: 0,
          ...tree,
          removed: true,
        }
      : {
          id: C.SpacePageId.make(id),
          spaceId: C.SpaceId.make(row.spaceId),
          revision: row.revision,
          bodyRevision: row.bodyRevision,
          ...tree,
        };
  });
  return { pages, spaces: [...collector.spaces] } satisfies PageChangeBatch;
});

interface Mailbox {
  readonly pages: Map<string, C.SpacePageChange>;
  readonly spaces: Set<string>;
  overflow: boolean;
}

const merge = (mailbox: Mailbox, batch: PageChangeBatch) => {
  if (mailbox.overflow) return;
  for (const next of batch.pages) {
    const held = mailbox.pages.get(next.id);
    mailbox.pages.set(
      next.id,
      held === undefined
        ? next
        : {
            ...next,
            revision: Math.max(held.revision, next.revision),
            bodyRevision: Math.max(held.bodyRevision, next.bodyRevision),
            ...(held.tree === true || next.tree === true ? { tree: true as const } : {}),
            ...(held.removed === true || next.removed === true ? { removed: true as const } : {}),
          },
    );
  }
  for (const space of batch.spaces) mailbox.spaces.add(space);
  if (mailbox.pages.size + mailbox.spaces.size > MAILBOX_LIMIT) {
    mailbox.overflow = true;
    mailbox.pages.clear();
    mailbox.spaces.clear();
  }
};

const chunks = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
  const out: A[][] = [];
  for (let index = 0; index < items.length; index += EVENT_LIMIT)
    out.push(items.slice(index, index + EVENT_LIMIT));
  return out;
};

/** Takes and clears a mailbox: one `resync` after an overflow, otherwise `changed` events of at most 256 entries. */
const take = (mailbox: Mailbox): ReadonlyArray<C.SpacePageChangeEvent> => {
  if (mailbox.overflow) {
    mailbox.overflow = false;
    return [{ type: "resync" }];
  }
  const pageChunks = chunks([...mailbox.pages.values()]);
  const spaceChunks = chunks([...mailbox.spaces].map((id) => C.SpaceId.make(id)));
  mailbox.pages.clear();
  mailbox.spaces.clear();
  const count = Math.max(pageChunks.length, spaceChunks.length);
  return Array.from({ length: count }, (_, index) => ({
    type: "changed" as const,
    pages: pageChunks[index] ?? [],
    spaces: spaceChunks[index] ?? [],
  }));
};

export const makePageHub = () =>
  makeChangeHub<PageChangeBatch, Mailbox, C.SpacePageChangeEvent>({
    empty: () => ({ pages: new Map(), spaces: new Set(), overflow: false }),
    isEmpty: (batch) => batch.pages.length === 0 && batch.spaces.length === 0,
    merge,
    take,
    resync: { type: "resync" },
  });
