import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/sql/SqlClient";

import {
  createMessageSearchTriggers,
  indexedMessageCondition,
  indexedMessageText,
} from "../../orchestration-v2/messageSearchIndex.ts";

/**
 * Full-text index for thread message search. The trigram tokenizer matches any
 * substring of three or more characters, ignoring case and accents, so
 * identifiers inside code still match, without the full-table scan a
 * `LIKE '%q%'` needs.
 *
 * It holds what the user wrote and what agents answered. User-role messages
 * that agents or the system wrote (pull request updates, task notices) would
 * flood results and read as "You".
 *
 * The index is contentless and keyed by the message rowid: search reads the
 * text back from the message row, so the text is not stored twice. `t2 doctor`
 * rebuilds it after its VACUUM, since SQLite does not promise to keep rowids.
 * Thread search scans the same messages when the index is missing.
 *
 * Triggers keep it in sync with every write to the messages table. Streaming
 * messages are indexed once they finish, with apostrophes folded as search
 * folds them.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Older system SQLite builds may lack these FTS5 options; search can scan messages instead.
  // Only SQLITE_ERROR signals unsupported options. Disk and I/O failures must fail the migration
  // so the next startup retries creating the index.
  const created = yield* sql`
    CREATE VIRTUAL TABLE orchestration_v2_message_search USING fts5(
      text,
      content = '',
      contentless_delete = 1,
      tokenize = 'trigram remove_diacritics 1'
    )
  `.pipe(
    Effect.as(true),
    Effect.catchIf(
      (cause) =>
        Predicate.hasProperty(cause.reason.cause, "errcode") && cause.reason.cause.errcode === 1,
      (cause) =>
        Effect.logWarning(
          "Message search index unavailable; search will scan messages.",
          cause,
        ).pipe(Effect.as(false)),
    ),
  );
  if (!created) return;
  yield* createMessageSearchTriggers(sql);
  yield* sql`
    INSERT INTO orchestration_v2_message_search (rowid, text)
    SELECT messages.rowid, ${indexedMessageText(sql, "messages.payload_json")}
    FROM orchestration_v2_projection_messages AS messages
    WHERE ${indexedMessageCondition(sql)}
      AND json_extract(messages.payload_json, '$.text') IS NOT NULL
  `;
});
