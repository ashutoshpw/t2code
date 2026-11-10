import * as Schema from "effect/Schema";

import { EnvironmentId, MessageId, ThreadId } from "./baseSchemas.ts";
import {
  COMPOSER_CONTEXT_MAX_RECORDS,
  ComposerContextRecord,
  SpaceContextSelector,
} from "./composerContext.ts";
import { ForwardCompatibleArray } from "./baseSchemas.ts";

export const COMPOSER_CONTEXT_CLIPBOARD_MIME = "web application/x-t2-context-fragment+json";

export const ComposerContextClipboardFragment = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: Schema.optional(ThreadId),
    messageId: Schema.optional(MessageId),
  }),
  selectors: Schema.optionalKey(
    Schema.Array(SpaceContextSelector).check(Schema.isMaxLength(COMPOSER_CONTEXT_MAX_RECORDS)),
  ),
  // Bound raw input before forward-compatible decoding drops unknown records.
  records: Schema.Array(Schema.Unknown)
    .check(Schema.isMaxLength(COMPOSER_CONTEXT_MAX_RECORDS))
    .pipe(Schema.decodeTo(ForwardCompatibleArray(ComposerContextRecord))),
});
export type ComposerContextClipboardFragment = typeof ComposerContextClipboardFragment.Type;
