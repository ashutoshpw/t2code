import { expect, it } from "vite-plus/test";
import {
  SpaceAssetId,
  SpaceBlockId,
  type SpaceAssetMetadata,
  type SpaceBlock,
  type SpaceCapability,
} from "@t2code/contracts/spaces";
import { MobileSpaceImageBudget, MobileSpaceImageViewer } from "./media";

const assetId = SpaceAssetId.make("image");
const image: SpaceBlock = {
  id: SpaceBlockId.make("image-block"),
  type: "image",
  version: 1,
  order: "a",
  parentId: null,
  content: { assetId },
};
const metadata: SpaceAssetMetadata = {
  assetId,
  digest: "digest",
  byteSize: 1024,
  mimeType: "image/png",
  name: "original.png",
  imageDimensions: { width: 100, height: 100 },
};
function setup(budget = new MobileSpaceImageBudget()) {
  let now = 0,
    allowed = true;
  let capability = {
    version: 2,
    features: { assets: true },
    limits: { assets: { maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 24_000_000 } },
  } as SpaceCapability;
  let read = async (_signal: AbortSignal) => metadata;
  let signed = () => ({
    relativeUrl: `/api/assets/token-${++mints}/original.png`,
    fileRevision: metadata.digest,
    expiresAt: now + 1000,
  });
  let reads = 0,
    mints = 0;
  const shares: string[] = [],
    dispositions: string[] = [];
  const viewer = new MobileSpaceImageViewer({
    budget,
    now: () => now,
    access: () => ({
      capability,
      httpBaseUrl: "https://selected.example/environment/",
      current: () => allowed,
    }),
    metadata: (_id, signal) => {
      reads++;
      return read(signal);
    },
    mint: async (_id, disposition) => {
      dispositions.push(disposition);
      return signed();
    },
    share: async (input) => {
      if (input.current() && !input.signal.aborted) shares.push(input.url);
    },
  });
  return {
    viewer,
    shares,
    dispositions,
    get reads() {
      return reads;
    },
    get mints() {
      return mints;
    },
    setNow: (value: number) => {
      now = value;
    },
    deny: () => {
      allowed = false;
    },
    cap: (value: SpaceCapability) => {
      capability = value;
    },
    get capability() {
      return capability;
    },
    read: (value: typeof read) => {
      read = value;
    },
    sign: (value: typeof signed) => {
      signed = value;
    },
  };
}

it("reauthorizes image expiry/remint and original sharing without changing the inline source or adding durable state", async () => {
  const h = setup();
  await h.viewer.open(image, () => true);
  const first = h.viewer.url();
  expect(first).toBe("https://selected.example/api/assets/token-1/original.png");
  h.setNow(1000);
  expect(h.viewer.url()).toBeNull();
  await h.viewer.refresh();
  const second = h.viewer.url();
  expect(second).toContain("token-2");
  await h.viewer.share();
  expect(h.shares).toEqual(["https://selected.example/api/assets/token-3/original.png"]);
  expect(h.dispositions).toEqual(["inline", "inline", "attachment"]);
  expect(h.viewer.url()).toBe(second);
  h.deny();
  await h.viewer.refresh();
  await h.viewer.share();
  expect(h.viewer.url()).toBeNull();
  expect(h.reads).toBe(3);
  h.viewer.close();
});

it("bounds decoder metadata and refuses wrong assets, opaque blocks or unsupported capabilities before signing", async () => {
  for (const change of [
    { byteSize: 10 * 1024 * 1024 + 1 },
    { mimeType: "application/pdf" as const },
    { imageDimensions: undefined },
    { imageDimensions: { width: 0, height: 1 } },
    { imageDimensions: { width: 5000, height: 5000 } },
    { assetId: SpaceAssetId.make("wrong") },
  ]) {
    const h = setup();
    h.read(async () => ({ ...metadata, ...change }));
    await h.viewer.open(image, () => true);
    expect(h.viewer.url()).toBeNull();
    expect(h.mints).toBe(0);
    expect(h.viewer.getSnapshot().error).toContain("policy");
    h.viewer.close();
  }
  for (const change of [{ version: 1 }, { version: 3 }, { features: {} }, { limits: {} }]) {
    const h = setup();
    h.cap({ ...h.capability, ...change } as SpaceCapability);
    await h.viewer.open(image, () => true);
    expect(h.reads).toBe(0);
    expect(h.viewer.url()).toBeNull();
  }
  const h = setup();
  await h.viewer.open({ ...image, future: true }, () => true);
  expect(h.reads).toBe(0);
  expect(h.viewer.getSnapshot().assetId).toBeNull();
});

it("refuses signed origin/digest/expiry confusion while retaining the original source selection", async () => {
  for (const change of [
    { relativeUrl: "//other.example/api/assets/t/a.png" },
    { relativeUrl: "/api/assets/t/a.png?forward=elsewhere" },
    { relativeUrl: "/other/a.png" },
    { fileRevision: "other" },
    { expiresAt: 0 },
  ]) {
    const h = setup();
    h.sign(() => ({
      relativeUrl: "/api/assets/t/a.png",
      fileRevision: metadata.digest,
      expiresAt: 1000,
      ...change,
    }));
    await h.viewer.open(image, () => true);
    expect(h.viewer.url()).toBeNull();
    expect(h.viewer.getSnapshot().assetId).toBe(assetId);
    expect(h.viewer.getSnapshot().error).toContain("signed image source");
    h.viewer.close();
  }
});

it("holds the global viewer permit through an aborted pending read and never admits a late source after close", async () => {
  const budget = new MobileSpaceImageBudget(),
    first = setup(budget),
    second = setup(budget);
  const reply = Promise.withResolvers<SpaceAssetMetadata>();
  let signal: AbortSignal | undefined;
  first.read(async (current) => {
    signal = current;
    return reply.promise;
  });
  const opening = first.viewer.open(image, () => true);
  first.viewer.close();
  expect(signal?.aborted).toBe(true);
  await second.viewer.open(image, () => true);
  expect(second.reads).toBe(0);
  reply.resolve(metadata);
  await opening;
  expect(first.viewer.getSnapshot().assetId).toBeNull();
  expect(first.mints).toBe(0);
  await second.viewer.open(image, () => true);
  expect(second.viewer.url()).not.toBeNull();
  first.viewer.close();
  const third = setup(budget);
  await third.viewer.open(image, () => true);
  expect(third.reads).toBe(0);
  second.viewer.close();
  await third.viewer.open(image, () => true);
  expect(third.reads).toBe(1);
  third.viewer.close();
});

it("does not sign or publish after the source/input owner or connection invalidates during metadata read", async () => {
  for (const mode of ["source", "connection"]) {
    const h = setup();
    const reply = Promise.withResolvers<SpaceAssetMetadata>();
    let current = true;
    h.read(() => reply.promise);
    const pending = h.viewer.open(image, () => current);
    if (mode === "source") current = false;
    else h.deny();
    reply.resolve(metadata);
    await pending;
    expect(h.mints).toBe(0);
    expect(h.viewer.url()).toBeNull();
    h.viewer.close();
  }
});
