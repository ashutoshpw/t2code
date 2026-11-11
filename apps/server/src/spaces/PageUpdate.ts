import * as Effect from "effect/Effect";

import { isoNow } from "./databases/Types.ts";
import * as CellStore from "./databases/CellStore.ts";
import * as DatabaseStore from "./databases/DatabaseStore.ts";
import * as PageStore from "./PageStore.ts";
import * as RevisionStore from "./RevisionStore.ts";
import * as SearchStore from "./SearchStore.ts";
import * as SpacesSql from "./SpacesSql.ts";

/**
 * The one place a page's title or icon changes: `updatePage` and a row's title cell both call it
 * so the search entry, history, revision and the row's title mirror cell cannot drift apart.
 */
export const apply = Effect.fn("SpacesPages.applyUpdate")(function* (
  page: PageStore.PageRow,
  next: { readonly title: string; readonly icon: string | null },
  mutationId: string,
  nowMs: number,
  bumpData = true,
) {
  const sql = yield* SpacesSql.SpacesSql;
  const titleChanged = page.title !== next.title;
  if (!titleChanged && next.icon === (page.icon ?? null)) return false;
  const now = isoNow(nowMs);
  if (titleChanged) yield* SearchStore.writeTitle(page.page_id, next.title);
  yield* sql`UPDATE spaces_pages SET title = ${next.title}, icon = ${next.icon}, revision = revision + 1, updated_at = ${now} WHERE page_id = ${page.page_id}`;
  yield* RevisionStore.capture(
    {
      pageId: page.page_id,
      toRevision: page.revision + 1,
      mutationId,
      pageBefore: PageStore.preimage(page),
      blocksBefore: [],
    },
    nowMs,
  );
  if (page.data_source_id !== null && titleChanged) {
    yield* CellStore.writeTitleMirror(page.page_id, page.data_source_id, next.title);
    if (bumpData) yield* DatabaseStore.bumpData(page.data_source_id, now);
  }
  return true;
});
