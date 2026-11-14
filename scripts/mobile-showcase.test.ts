// @effect-diagnostics nodeBuiltinImport:off - expectations mirror the host path joins the script under test performs.
import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";

import type { ShowcaseStoreAssetSpec } from "./mobile-showcase.config.ts";
import {
  encodeAndroidPairingUrls,
  normalizeStorePng,
  parsePairingCredentialOutput,
  readPngMetadata,
  validateStoreAsset,
} from "./mobile-showcase.ts";

const appleSpec: ShowcaseStoreAssetSpec = {
  store: "apple",
  directory: "apple/iphone-test",
  width: 1284,
  height: 2778,
  minimumUploadCount: 1,
  maximumUploadCount: 10,
};

const googleSpec: ShowcaseStoreAssetSpec = {
  store: "google-play",
  directory: "google-play/phone",
  width: 1080,
  height: 1920,
  minimumUploadCount: 2,
  maximumUploadCount: 8,
  maximumFileSizeBytes: 8 * 1024 * 1024,
};

const config: ShowcaseConfig = {
  outputDirectory: "artifacts",
  metroPort: 8199,
  settleDelayMs: 1,
  devices: [
    {
      id: "phone",
      platform: "ios",
      simulator: "iPhone Test",
      appearance: "dark",
      theme: "t3-code",
      scenes: ["thread", "review"],
      storeAsset: appleSpec,
    },
    {
      id: "pixel",
      platform: "android",
      avd: "Pixel_Test",
      appearance: "light",
      theme: "t3-code",
      scenes: ["thread", "terminal"],
      storeAsset: googleSpec,
    },
  ],
};

it("parses repeatable capture filters", () => {
  const options = parseShowcaseCliArgs([
    "--platform",
    "ios",
    "--device",
    "phone",
    "--scene",
    "review",
    "--appearance",
    "both",
    "--skip-build",
  ]);
  assert.deepStrictEqual([...options.platforms], ["ios"]);
  assert.deepStrictEqual([...options.deviceIds], ["phone"]);
  assert.deepStrictEqual([...options.scenes], ["review"]);
  assert.deepStrictEqual([...options.appearances], ["light", "dark"]);
  assert.equal(options.skipBuild, true);
});

it("rejects unsupported system appearances", () => {
  assert.throws(
    () => parseShowcaseCliArgs(["--appearance", "sepia"]),
    /Unsupported appearance 'sepia'/u,
  );
});

it("parses repeatable and expanded theme filters", () => {
  assert.deepStrictEqual(
    [...parseShowcaseCliArgs(["--theme", "ocean", "--theme", "ember"]).themes],
    ["ocean", "ember"],
  );
  assert.deepStrictEqual(
    [...parseShowcaseCliArgs(["--theme", "all"]).themes],
    [...SHOWCASE_THEMES],
  );
});

it("rejects unsupported themes instead of capturing the default palette", () => {
  assert.throws(() => parseShowcaseCliArgs(["--theme", "sunset"]), /Unsupported theme 'sunset'/u);
});

it("parses validation-only mode", () => {
  assert.equal(parseShowcaseCliArgs(["--validate-only"]).validateOnly, true);
});

it("selects an explicit CI Android ABI without changing the local default", () => {
  assert.equal(resolveShowcaseAndroidAbi(undefined), "arm64-v8a");
  assert.equal(resolveShowcaseAndroidAbi("x86_64"), "x86_64");
  assert.throws(() => resolveShowcaseAndroidAbi("mips"), /Unsupported T2_SHOWCASE_ANDROID_ABI/u);
});

it("uses platform-correct default Android SDK roots", () => {
  assert.equal(
    resolveAndroidSdkRoot({ HOME: "/Users/showcase" }, "darwin"),
    "/Users/showcase/Library/Android/sdk",
  );
  assert.equal(
    resolveAndroidSdkRoot({ HOME: "/home/showcase" }, "linux"),
    "/home/showcase/Android/Sdk",
  );
  assert.equal(
    resolveAndroidSdkRoot(
      { HOME: "/home/showcase", ANDROID_SDK_ROOT: "/opt/android-sdk" },
      "linux",
    ),
    "/opt/android-sdk",
  );
});

it("plans only scenes supported by each selected device", () => {
  const options = parseShowcaseCliArgs(["--platform", "all", "--scene", "terminal"]);
  const captures = planShowcaseCaptures(config, options);
  assert.deepStrictEqual(
    captures.map((capture) => ({
      id: capture.device.id,
      appearance: capture.appearance,
      scenes: capture.scenes,
    })),
    [{ id: "pixel", appearance: "light", scenes: ["terminal"] }],
  );
});

it("expands both appearances into independent upload-ready directories", () => {
  const options = parseShowcaseCliArgs(["--device", "phone", "--appearance", "both"]);
  const captures = planShowcaseCaptures(config, options);

  assert.deepStrictEqual(
    captures.map((capture) => ({
      appearance: capture.appearance,
      directory: showcaseCaptureDirectory("/captures", capture),
    })),
    [
      {
        appearance: "light",
        directory: NodePath.join("/captures", "apple", "iphone-test", "light", "t3-code"),
      },
      {
        appearance: "dark",
        directory: NodePath.join("/captures", "apple", "iphone-test", "dark", "t3-code"),
      },
    ],
  );
});

it("expands themes into independent upload-ready directories per appearance", () => {
  const options = parseShowcaseCliArgs([
    "--device",
    "phone",
    "--appearance",
    "both",
    "--theme",
    "ocean",
    "--theme",
    "ember",
  ]);

  assert.deepStrictEqual(
    planShowcaseCaptures(config, options).map((capture) =>
      showcaseCaptureDirectory("/captures", capture),
    ),
    [
      NodePath.join("/captures", "apple", "iphone-test", "light", "ocean"),
      NodePath.join("/captures", "apple", "iphone-test", "light", "ember"),
      NodePath.join("/captures", "apple", "iphone-test", "dark", "ocean"),
      NodePath.join("/captures", "apple", "iphone-test", "dark", "ember"),
    ],
  );
});

it("rejects unknown devices instead of silently capturing another target", () => {
  const options = parseShowcaseCliArgs(["--device", "missing"]);
  assert.throws(() => planShowcaseCaptures(config, options), /Unknown device 'missing'/u);
});

it("reads captured PNG dimensions from the IHDR header", () => {
  const bytes = new Uint8Array(26);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 1320);
  view.setUint32(20, 2868);
  view.setUint8(24, 8);
  view.setUint8(25, 2);
  assert.deepStrictEqual(readPngDimensions(bytes), { width: 1320, height: 2868 });
  assert.deepStrictEqual(readPngMetadata(bytes), {
    width: 1320,
    height: 2868,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

function rgbaPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

it("converts simulator RGBA captures to upload-safe 24-bit RGB PNGs", () => {
  const normalized = normalizeStorePng(rgbaPng(2, 3));
  assert.deepStrictEqual(readPngMetadata(normalized), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

const storeSpec: ShowcaseStoreAssetSpec = {
  store: "apple",
  directory: "fixture",
  width: 2,
  height: 3,
  minimumUploadCount: 1,
  maximumUploadCount: 10,
};

it("validates a complete RGB PNG from an offset byte view", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const padded = Buffer.concat([Buffer.from([0]), bytes, Buffer.from([0])]);
  assert.deepStrictEqual(validateStoreAsset(storeSpec, padded.subarray(1, -1)), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

it("rejects PNG metadata without image data during store validation", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  assert.throws(
    () => validateStoreAsset(storeSpec, bytes.subarray(0, 26), "threads.png"),
    /threads\.png is not a valid PNG/,
  );
  assert.throws(() => validateStoreAsset(storeSpec, bytes.subarray(0, 33)), /is not a valid PNG/);
});

it("rejects a PNG truncated inside its image data", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const imageData = bytes.indexOf("IDAT");
  assert.notEqual(imageData, -1);
  assert.throws(
    () => validateStoreAsset(storeSpec, bytes.subarray(0, imageData + 5)),
    /is not a valid PNG/,
  );
});

it("rejects a PNG with a corrupt image-data checksum", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const imageData = bytes.indexOf("IDAT");
  assert.notEqual(imageData, -1);
  const checksum = imageData + 4 + bytes.readUInt32BE(imageData - 4);
  bytes[checksum] = bytes.readUInt8(checksum) ^ 1;
  assert.throws(() => validateStoreAsset(storeSpec, bytes), /is not a valid PNG/);
});

it("reads multiline JSON from the pairing CLI", () => {
  assert.equal(
    parsePairingCredentialOutput('server log\n{\n  "credential": "PAIR-ME"\n}\n'),
    "PAIR-ME",
  );
});

it("encodes Android pairing URLs without shell-sensitive JSON quotes", () => {
  const urls = ["http://10.0.2.2:65164/#token=ONE", "http://10.0.2.2:65198/#token=TWO"];
  const encoded = encodeAndroidPairingUrls(urls);
  assert.equal(encoded.startsWith("json-uri:"), true);
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(encoded.slice("json-uri:".length))), urls);
  assert.equal(encoded.includes('"'), false);
});
