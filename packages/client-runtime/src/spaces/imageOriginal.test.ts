import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
import {
  decodeSpaceImageRecord,
  decodeSpaceMediaRecords,
  SpaceImageUploads,
} from "./imageUpload.ts";

const key = { environmentId: EnvironmentId.make("originals"), pageId: SpacePageId.make("page") };
function record(original: { size: number; type: string }) {
  return {
    version: 1,
    slot: 0,
    sequence: 1,
    id: "intent",
    key,
    original,
    phase: "original",
    intent: {
      environmentId: key.environmentId,
      requestId: "intent",
      expectedBytes: original.size,
      mimeType: original.type,
      mediaKind: "image",
      name: "original.png",
    },
  };
}
it("preserves actual browser Blob bytes and stored formats while rejecting non-Blob defaults", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const stored = record(blob);
  const decoded = decodeSpaceImageRecord(structuredClone(stored));
  expect(await decoded.original.bytes()).toEqual(new Uint8Array([1, 2, 3]));
  expect(decoded.intent).toEqual(stored.intent);
  expect(Object.isFrozen(decoded.intent)).toBe(true);
  expect(() => decodeSpaceImageRecord(record({ size: 3, type: "image/png" }))).toThrow();
  const pdf = new Blob(["%PDF-"], { type: "application/pdf" });
  expect(
    decodeSpaceImageRecord({
      ...record(pdf),
      version: 2,
      intent: { ...record(pdf).intent, mediaKind: "pdf" },
    }).original,
  ).toBe(pdf);
});
it("admits and rehydrates an opaque original through the same engine without a browser Blob global", async () => {
  const value = Object.freeze({ size: 3, type: "image/png", token: "owned-original" });
  const codec = (input: unknown) => {
    if (input !== value) throw new Error("Unknown original handle");
    return value;
  };
  const writes: unknown[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("No transport before explicit upload");
  };
  vi.stubGlobal("Blob", undefined);
  try {
    const owner = new SpaceImageUploads({
      original: codec,
      store: {
        load: async () => [],
        put: async (r) => {
          writes.push(r);
        },
        remove: unexpected,
      },
      access: () => ({
        session: value,
        limits: {
          maxImageBytes: 10,
          maxImagePixels: 24000000,
          maxPdfBytes: 25,
          maxVideoBytes: 50,
          maxHeaderBytes: 65536,
          maxEnvironmentBytes: 100000000,
          maxPendingPerCaller: 2,
          maxPendingUploads: 8,
          maxActiveUploads: 1,
          uploadTtlMs: 60000,
          recoveryBatchRows: 8,
          recoveryBatchBytes: 1000000,
        },
      }),
      mint: unexpected,
      status: unexpected,
      finalize: unexpected,
      metadata: unexpected,
      post: () => {
        throw new Error("No POST");
      },
      draft: async () => null,
      saved: async () => false,
      newId: () => "intent",
      changed: () => {},
    });
    await owner.add(key, value, "original.png");
    expect(writes).toHaveLength(1);
    const retained = decodeSpaceMediaRecords(writes, codec);
    expect(retained[0]?.original).toBe(value);
    expect(retained[0]).toMatchObject({
      phase: "original",
      sequence: 1,
      intent: { requestId: "intent", expectedBytes: 3 },
    });
    expect(() => decodeSpaceImageRecord(record({ ...value }), codec)).toThrow("Unknown original");
    expect(() =>
      decodeSpaceImageRecord(
        { ...record(value), intent: { ...record(value).intent, expectedBytes: 4 } },
        codec,
      ),
    ).toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});
