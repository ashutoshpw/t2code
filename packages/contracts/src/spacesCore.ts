import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, PositiveInt } from "./baseSchemas.ts";

// Provisional editor values; order tokens and persistence are owned by the future service.
export const StableId = Schema.String.check(Schema.isMinLength(1));
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

export const SPACE_TEXT_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;
export const SpaceTextColor = Schema.Literals(SPACE_TEXT_COLORS);
export type SpaceTextColor = typeof SpaceTextColor.Type;

export const SpaceKnownMark = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["bold", "italic", "underline", "strike", "code"]),
    version: Schema.Literal(1),
  }),
  Schema.Struct({
    type: Schema.Literals(["color", "highlight"]),
    version: Schema.Literal(1),
    value: SpaceTextColor,
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

export const spaceBlockBase = {
  id: SpaceBlockId,
  parentId: Schema.NullOr(SpaceBlockId),
  order: StableId,
  version: Schema.Literal(1),
};

export const SpaceReceiptEpoch = StableId.pipe(Schema.brand("SpaceReceiptEpoch"));
export type SpaceReceiptEpoch = typeof SpaceReceiptEpoch.Type;
export const SpaceMutationId = StableId.pipe(Schema.brand("SpaceMutationId"));
export type SpaceMutationId = typeof SpaceMutationId.Type;
export const SpaceCursor = StableId.pipe(Schema.brand("SpaceCursor"));
export type SpaceCursor = typeof SpaceCursor.Type;

export const SpaceMutationAdmission = Schema.Struct({
  epoch: SpaceReceiptEpoch,
  acceptsUntil: IsoDateTime,
  retainUntil: IsoDateTime,
});
export type SpaceMutationAdmission = typeof SpaceMutationAdmission.Type;

const pictograph = String.raw`\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?`;
export const SPACE_PAGE_ICON_PATTERN = new RegExp(
  String.raw`^(?:${pictograph}(?:\u200D${pictograph})*|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)$`,
  "u",
);
export const SpacePageIcon = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.isPattern(SPACE_PAGE_ICON_PATTERN),
);
export type SpacePageIcon = typeof SpacePageIcon.Type;

export const mutationAck = { mutationId: SpaceMutationId, receiptEpoch: SpaceReceiptEpoch };
export const mutationInput = { environmentId: EnvironmentId, ...mutationAck };
