import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

// Provisional editor values; order tokens and persistence are owned by the future service.
const StableId = Schema.String.check(Schema.isMinLength(1));
export const SpaceId = StableId.pipe(Schema.brand("SpaceId"));
export type SpaceId = typeof SpaceId.Type;
export const SpacePageId = StableId.pipe(Schema.brand("SpacePageId"));
export type SpacePageId = typeof SpacePageId.Type;
export const SpaceBlockId = StableId.pipe(Schema.brand("SpaceBlockId"));
export type SpaceBlockId = typeof SpaceBlockId.Type;
export const SpaceAssetId = StableId.pipe(Schema.brand("SpaceAssetId"));
export type SpaceAssetId = typeof SpaceAssetId.Type;

export const SpacePageTarget = Schema.Struct({ environmentId: EnvironmentId, pageId: SpacePageId });
export type SpacePageTarget = typeof SpacePageTarget.Type;
export const SpaceBlockTarget = Schema.Struct({
  environmentId: EnvironmentId,
  pageId: SpacePageId,
  blockId: SpaceBlockId,
});
export type SpaceBlockTarget = typeof SpaceBlockTarget.Type;

export const SpaceKnownMark = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["bold", "italic", "strike", "code"]),
    version: Schema.Literal(1),
  }),
  Schema.Struct({ type: Schema.Literal("link"), version: Schema.Literal(1), href: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("page_mention"),
    version: Schema.Literal(1),
    target: SpacePageTarget,
  }),
  Schema.Struct({
    type: Schema.Literal("block_mention"),
    version: Schema.Literal(1),
    target: SpaceBlockTarget,
  }),
]);
export type SpaceKnownMark = typeof SpaceKnownMark.Type;

export const SpaceMark = Schema.StructWithRest(
  Schema.Struct({ type: StableId, version: PositiveInt }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceMark = typeof SpaceMark.Type;
export const SpaceRichRun = Schema.StructWithRest(
  Schema.Struct({ text: Schema.String, marks: Schema.Array(SpaceMark) }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceRichRun = typeof SpaceRichRun.Type;
export const SpaceRichText = Schema.Array(SpaceRichRun);
export type SpaceRichText = typeof SpaceRichText.Type;

const blockBase = {
  id: SpaceBlockId,
  parentId: Schema.NullOr(SpaceBlockId),
  order: StableId,
  version: Schema.Literal(1),
};
const textContent = { runs: SpaceRichText };
export const SpaceKnownBlock = Schema.Union([
  Schema.Struct({
    ...blockBase,
    type: Schema.Literals(["paragraph", "quote", "bulleted_item", "numbered_item"]),
    content: Schema.Struct(textContent),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("heading"),
    content: Schema.Struct({ ...textContent, level: Schema.Literals([1, 2, 3]) }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("todo_item"),
    content: Schema.Struct({ ...textContent, checked: Schema.Boolean }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("callout"),
    content: Schema.Struct({ ...textContent, icon: Schema.String }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("code"),
    content: Schema.Struct({ text: Schema.String, language: Schema.String }),
  }),
  Schema.Struct({ ...blockBase, type: Schema.Literal("divider"), content: Schema.Struct({}) }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literals(["image", "pdf", "video"]),
    content: Schema.Struct({ assetId: SpaceAssetId, caption: Schema.optionalKey(SpaceRichText) }),
  }),
  Schema.Struct({
    ...blockBase,
    type: Schema.Literal("child_page"),
    content: Schema.Struct({ pageId: SpacePageId }),
  }),
]);
export type SpaceKnownBlock = typeof SpaceKnownBlock.Type;

// Decode the envelope without routing future payloads through a lossy known-type union.
export const SpaceBlock = Schema.StructWithRest(
  Schema.Struct({ ...blockBase, type: StableId, version: PositiveInt, content: Schema.Json }),
  [Schema.Record(Schema.String, Schema.Json)],
);
export type SpaceBlock = typeof SpaceBlock.Type;
export const SpaceBlockWindow = Schema.Struct({
  revision: NonNegativeInt,
  blocks: Schema.Array(SpaceBlock),
});
export type SpaceBlockWindow = typeof SpaceBlockWindow.Type;
