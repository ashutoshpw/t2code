import * as Schema from "effect/Schema";
import { SpaceAssetMimeType, type SpaceAssetUploadCreateInput } from "@t2code/contracts/spaces";
import {
  decodeSpaceMediaRecords,
  spaceMediaKind,
  spaceImageMaxBytes,
  type SpaceImageRecord,
} from "@t2code/client-runtime/spaces";

const originalSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("spaces-file"),
  fileSlot: Schema.Literals([0, 1]),
  token: Schema.String,
  size: Schema.Number,
  type: SpaceAssetMimeType,
  sha256: Schema.String,
});
export type NativeSpaceOriginal = typeof originalSchema.Type;
export type NativeSpaceImageRecord = SpaceImageRecord<NativeSpaceOriginal>;
export type NativeSpaceMediaKind = SpaceAssetUploadCreateInput["mediaKind"];
export function nativeSpaceMediaMaxBytes(kind: NativeSpaceMediaKind) {
  return kind === "image" ? spaceImageMaxBytes : (kind === "pdf" ? 25 : 50) * 1024 * 1024;
}
const decode = Schema.decodeUnknownSync(originalSchema, { onExcessProperty: "error" });
export const nativeSpaceOriginalCodec = (input: unknown): NativeSpaceOriginal => {
  const value = decode(input);
  const kind = spaceMediaKind(value.type);
  const maxBytes = kind === null ? 0 : nativeSpaceMediaMaxBytes(kind);
  if (
    !/^[0-9a-f]{32}$/.test(value.token) ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    kind === null ||
    value.size > maxBytes
  )
    throw new Error("Invalid Spaces original; retained files were not changed");
  return Object.freeze(value);
};
export const nativeSpaceMediaRecordBytes = 34 * 1024;
export function decodeNativeSpaceMediaRecords(input: readonly unknown[]) {
  const records = decodeSpaceMediaRecords(input, nativeSpaceOriginalCodec);
  for (const left of records)
    for (const right of records) {
      if (
        left.original.fileSlot === right.original.fileSlot &&
        JSON.stringify(left.original) !== JSON.stringify(right.original)
      )
        throw new Error("Spaces file slot has conflicting ownership; all originals retained");
    }
  return records;
}
