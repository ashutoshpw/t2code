import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
import {
  decodeSpaceImageRecord,
  decodeSpaceMediaRecords,
  spaceImageMaxBytes,
} from "./imageUpload.ts";
import { SpaceImagePreviewBudget } from "./imagePreview.ts";

const key = { environmentId: EnvironmentId.make("images"), pageId: SpacePageId.make("page") };
function original() {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  return {
    version: 1,
    slot: 0,
    sequence: 1,
    id: "image-intent",
    key,
    original: blob,
    phase: "original",
    intent: {
      environmentId: key.environmentId,
      requestId: "image-intent",
      expectedBytes: 3,
      mimeType: "image/png",
      mediaKind: "image",
      name: "image.png",
    },
  };
}
describe("retained image record contract", () => {
  it("retains the exact immutable Blob and wire intent and rejects corrupt or oversized originals", async () => {
    const source = original(),
      decoded = decodeSpaceImageRecord(source);
    expect(await decoded.original.bytes()).toEqual(new Uint8Array([1, 2, 3]));
    expect(decoded.original).toBe(source.original);
    expect(Object.isFrozen(decoded.intent)).toBe(true);
    for (const value of [
      { ...source, original: new Blob(["other"], { type: "image/png" }) },
      { ...source, original: { size: 3, type: "image/png" } },
      { ...source, intent: { ...source.intent, requestId: "renewed" } },
      { ...source, phase: "upload" },
      { ...source, phase: "drafted" },
      { ...source, unknown: "retain unsupported data" },
      { ...source, sequence: -1 },
      { ...source, slot: 2 },
      {
        ...source,
        original: new Blob([new Uint8Array(spaceImageMaxBytes + 1)], { type: "image/png" }),
        intent: { ...source.intent, expectedBytes: spaceImageMaxBytes + 1 },
      },
    ])
      expect(() => decodeSpaceImageRecord(value)).toThrow();
    expect(await source.original.bytes()).toEqual(new Uint8Array([1, 2, 3]));
  });
});

it("bounds actual preview subscriptions across views, pixels and enlargement, including release/reacquisition", () => {
  const budget = new SpaceImagePreviewBudget();
  const a = budget.watch(24000000),
    b = budget.watch(24000000),
    c = budget.watch(1);
  const closeA = a.subscribe(() => {}),
    closeB = b.subscribe(() => {}),
    closeC = c.subscribe(() => {});
  expect(a.getSnapshot().active).toBe(true);
  expect(b.getSnapshot().active).toBe(true);
  expect(c.getSnapshot().active).toBe(false);
  a.enlarge(true);
  expect(() => b.enlarge(true)).toThrow("one enlarged");
  closeA();
  c.retry();
  expect(c.getSnapshot().active).toBe(true);
  b.enlarge(true);
  closeB();
  closeC();
  const small = Array.from({ length: 5 }, () => budget.watch(1));
  const close = small.map((view) => view.subscribe(() => {}));
  expect(small.map((view) => view.getSnapshot().active)).toEqual([true, true, true, true, false]);
  close[0]!();
  small[4]!.retry();
  expect(small[4]!.getSnapshot().active).toBe(true);
  close.forEach((release) => release());
  const again = a.subscribe(() => {});
  expect(a.getSnapshot().active).toBe(true);
  const anotherReader = a.subscribe(() => {});
  again();
  expect(a.getSnapshot().active).toBe(true);
  anotherReader();
  expect(a.getSnapshot().active).toBe(false);
});

it("decodes unchanged v1 images alongside v2 PDF/video records and retains unsupported versions or kind mismatches", () => {
  const image = original();
  for (const [kind, mime] of [
    ["pdf", "application/pdf"],
    ["video", "video/webm"],
  ] as const) {
    const value = {
      ...image,
      version: 2,
      slot: 1,
      id: kind,
      original: new Blob(["bytes"], { type: mime }),
      intent: {
        ...image.intent,
        mediaKind: kind,
        mimeType: mime,
        expectedBytes: 5,
        requestId: kind,
      },
    };
    const records = decodeSpaceMediaRecords([image, value]);
    expect(records[0]!.version).toBe(1);
    expect(records[0]!.intent).toEqual(image.intent);
    expect(records[1]!.intent.mediaKind).toBe(kind);
    expect(() => decodeSpaceMediaRecords([image, { ...value, version: 1 }])).toThrow();
    expect(() =>
      decodeSpaceMediaRecords([
        image,
        { ...value, intent: { ...value.intent, mediaKind: "image" } },
      ]),
    ).toThrow();
    expect(() => decodeSpaceMediaRecords([image, { ...value, version: 3 }])).toThrow();
    expect(image.original.size).toBe(3);
  }
});

it("refuses an over-budget retained record set without modifying either exact original intent", () => {
  const blob = new Blob([new Uint8Array(50 * 1024 * 1024)], { type: "video/mp4" });
  const make = (slot: number) => ({
    ...original(),
    version: 2,
    slot,
    id: `video-${slot}`,
    original: blob,
    intent: {
      ...original().intent,
      requestId: `video-${slot}`,
      expectedBytes: blob.size,
      mimeType: blob.type,
      mediaKind: "video",
    },
  });
  const first = make(0),
    second = make(1);
  expect(() => decodeSpaceMediaRecords([first, second])).toThrow("75 MiB");
  expect(first.intent.requestId).toBe("video-0");
  expect(second.original).toBe(blob);
});
