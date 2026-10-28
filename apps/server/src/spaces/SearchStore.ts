import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { byteLength, checkSearchLimit, searchLimits } from "./CorePolicy.ts";
import type { SummaryRow } from "./PageStore.ts";
import * as SpacesSql from "./SpacesSql.ts";

const known = Schema.is(C.SpaceKnownBlock);
const decodeKnown = Schema.decodeUnknownSync(C.SpaceKnownBlock);
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export function literalQuery(query: string) {
  checkSearchLimit("maxQueryBytes", byteLength(query));
  const terms = query.trim().split(/\s+/u).filter(Boolean);
  checkSearchLimit("maxTerms", terms.length);
  if (terms.length === 0) throw new C.SpaceValidationError({ reason: "invalid_search_query" });
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

const put = Effect.fn("SpacesSearch.put")(function* (
  sourceId: string,
  pageId: string,
  blockId: string | null,
  text: string,
) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`INSERT INTO spaces_search_docs(source_id,page_id,block_id,text,text_json_bytes)
    VALUES(${sourceId},${pageId},${blockId},${text},${byteLength(text)})
    ON CONFLICT(source_id) DO UPDATE SET page_id=excluded.page_id,text=excluded.text,text_json_bytes=excluded.text_json_bytes
    WHERE page_id IS NOT excluded.page_id OR text IS NOT excluded.text`;
});

export const writeTitle = Effect.fn("SpacesSearch.writeTitle")(function* (
  pageId: string,
  title: string,
) {
  yield* put(pageId, pageId, null, title);
});

const clearText = Effect.fn("SpacesSearch.clearText")(function* (pageId: string, id: string) {
  const sql = yield* SpacesSql.SpacesSql;
  yield* sql`UPDATE spaces_search_docs SET page_id=${pageId},text='',text_json_bytes=2
    WHERE source_id=${id} AND (page_id IS NOT ${pageId} OR text<>'')`;
});

export const writeBlock = Effect.fn("SpacesSearch.writeBlock")(function* (
  pageId: string,
  id: string,
  block: C.SpaceBlock | null,
) {
  const sql = yield* SpacesSql.SpacesSql;
  let text: string | undefined;
  if (block !== null && known(block)) {
    const content = decodeKnown(block).content;
    if ("runs" in content) text = content.runs.map((run) => run.text).join("");
    else if ("text" in content) text = content.text;
    else if ("caption" in content) text = content.caption?.map((run) => run.text).join("");
  }
  if (text === undefined) {
    if (block === null) yield* sql`DELETE FROM spaces_search_docs WHERE source_id=${id}`;
    else yield* clearText(pageId, id);
    return;
  }
  yield* put(id, pageId, id, text);
});

export const checkModule = Effect.fn("SpacesSearch.checkModule")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const modules = yield* sql<{ readonly name: string }>`PRAGMA module_list`;
  if (modules.some((module) => module.name === "fts5")) return;
  yield* sql`DROP TRIGGER IF EXISTS spaces_search_insert`;
  yield* sql`DROP TRIGGER IF EXISTS spaces_search_update`;
  yield* sql`DROP TRIGGER IF EXISTS spaces_search_delete`;
  yield* sql`UPDATE spaces_search_build SET phase='unsupported' WHERE singleton=1`;
});

export const advance = Effect.fn("SpacesSearch.advance")(function* () {
  const sql = yield* SpacesSql.SpacesSql;
  const [state] = yield* sql<{
    readonly phase: string;
    readonly after_id: string;
  }>`SELECT phase,after_id FROM spaces_search_build WHERE singleton=1`;
  if (!state) return "storage";
  if (state.phase === "unsupported" || state.phase === "ready") return state.phase;
  let consumed = 0;
  let bytes = 0;
  let after = state.after_id;
  if (state.phase === "pages") {
    const rows = yield* sql<{
      readonly page_id: string;
      readonly title: string;
    }>`SELECT page_id,title FROM spaces_pages WHERE page_id>${after} ORDER BY page_id LIMIT ${searchLimits.backfillRows + 1}`;
    for (const row of rows.slice(0, searchLimits.backfillRows)) {
      const size = byteLength({ ...row });
      if (bytes + size > searchLimits.backfillBytes) {
        if (consumed === 0) checkSearchLimit("backfillBytes", size);
        break;
      }
      yield* writeTitle(row.page_id, row.title);
      consumed++;
      bytes += size;
      after = row.page_id;
    }
    if (consumed === rows.length) {
      yield* sql`UPDATE spaces_search_build SET phase='blocks',after_id='' WHERE singleton=1`;
    } else yield* sql`UPDATE spaces_search_build SET after_id=${after} WHERE singleton=1`;
    return "building";
  }
  if (state.phase !== "blocks") return "storage";
  // octet_length reads record metadata; fields after payload can traverse overflow pages.
  const rows = yield* sql<{
    readonly block_id: string;
    readonly page_id: string;
    readonly payload_bytes: number;
  }>`SELECT block_id,page_id,octet_length(payload) AS payload_bytes FROM spaces_blocks
    WHERE block_id>${after} ORDER BY block_id LIMIT ${searchLimits.backfillRows + 1}`;
  bytes = byteLength(rows.map((row) => ({ ...row })));
  checkSearchLimit("backfillBytes", bytes);
  for (const row of rows.slice(0, searchLimits.backfillRows)) {
    if (bytes + row.payload_bytes > searchLimits.backfillBytes) {
      if (consumed === 0) checkSearchLimit("backfillBytes", bytes + row.payload_bytes);
      break;
    }
    const [body] = yield* sql<{
      readonly payload: string;
      readonly deleted: number;
    }>`SELECT payload,deleted FROM spaces_blocks WHERE block_id=${row.block_id}`;
    if (!body) return "storage";
    const value: unknown = body.deleted ? null : parseJson(body.payload);
    if (known(value)) yield* writeBlock(row.page_id, row.block_id, value);
    else if (body.deleted) yield* writeBlock(row.page_id, row.block_id, null);
    else yield* clearText(row.page_id, row.block_id);
    consumed++;
    bytes += row.payload_bytes;
    after = row.block_id;
  }
  if (consumed === rows.length) {
    yield* sql`UPDATE spaces_search_build SET phase='ready',after_id='' WHERE singleton=1`;
    return "ready";
  }
  yield* sql`UPDATE spaces_search_build SET after_id=${after} WHERE singleton=1`;
  return "building";
});

interface Candidate extends SummaryRow {
  readonly doc_id: number;
  readonly block_id: C.SpaceBlockId | null;
  readonly text_json_bytes: number;
}

export const candidates = Effect.fn("SpacesSearch.candidates")(function* (
  query: string,
  after: number,
) {
  const sql = yield* SpacesSql.SpacesSql;
  return yield* sql<Candidate>`SELECT p.page_id,p.space_id,p.title,p.revision,p.root_order,p.created_at,p.updated_at,
    p.trash_batch_id,p.trash_root_id,p.trashed_at_ms,d.doc_id,d.block_id,d.text_json_bytes,o.owner_block_id,
    b.page_id AS parent_page_id,b.deleted AS owner_deleted,parent.space_id AS parent_space_id,
    json_extract(b.payload,'$.type') AS owner_type
    FROM (SELECT rowid FROM spaces_search_fts WHERE spaces_search_fts MATCH ${query} AND rowid>CAST(${after} AS INTEGER)
      ORDER BY rowid LIMIT ${searchLimits.maxCandidates}) f
    JOIN spaces_search_docs d ON d.doc_id=f.rowid
    LEFT JOIN spaces_pages p ON p.page_id=d.page_id
    LEFT JOIN spaces_page_owners o ON o.child_page_id=p.page_id
    LEFT JOIN spaces_blocks b ON b.block_id=o.owner_block_id
    LEFT JOIN spaces_pages parent ON parent.page_id=b.page_id ORDER BY d.doc_id`;
});

export const snippet = Effect.fn("SpacesSearch.snippet")(function* (query: string, docId: number) {
  const sql = yield* SpacesSql.SpacesSql;
  // FTS5 rowid equality can ignore floating-point bindings; keep the lookup integer typed.
  const [row] = yield* sql<{
    readonly snippet: string;
  }>`SELECT snippet(spaces_search_fts,0,'','',' … ',32) AS snippet
    FROM spaces_search_fts WHERE spaces_search_fts MATCH ${query} AND rowid=CAST(${docId} AS INTEGER)`;
  if (!row) return yield* new C.SpaceSearchUnavailableError({ reason: "storage" });
  const points = Array.from(row.snippet);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (byteLength(points.slice(0, mid).join("")) <= searchLimits.maxSnippetBytes) low = mid;
    else high = mid - 1;
  }
  return points.slice(0, low).join("");
});
