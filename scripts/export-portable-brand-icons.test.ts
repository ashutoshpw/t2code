// @effect-diagnostics nodeBuiltinImport:off - The regression test reads tracked PNG fixtures directly.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { renderIcon } from "./export-portable-brand-icons.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const BRANDS = ["development", "nightly", "production"] as const;
const IOS_OUTPUTS = [
  "assets/dev/blueprint-ios-1024.png",
  "assets/nightly/nightly-ios-1024.png",
  "assets/prod/black-ios-1024.png",
] as const;

const pngMetadata = (contents: Buffer) => sharp(contents).metadata();

describe("portable brand icon framing", () => {
  it("renders iOS as opaque full-bleed squares while other families retain alpha", async () => {
    for (const brand of BRANDS) {
      const ios = await renderIcon(brand, 1024, { shape: "square" });
      const universal = await renderIcon(brand, 1024);
      const macos = await renderIcon(brand, 1024, { macos: true });

      expect((await pngMetadata(ios)).hasAlpha).toBe(false);
      expect((await pngMetadata(universal)).hasAlpha).toBe(true);
      expect((await pngMetadata(macos)).hasAlpha).toBe(true);
    }
  });

  it("keeps the tracked iOS renditions opaque", async () => {
    for (const relativePath of IOS_OUTPUTS) {
      const metadata = await pngMetadata(await NodeFSP.readFile(NodePath.join(ROOT, relativePath)));
      expect(metadata).toMatchObject({ width: 1024, height: 1024, hasAlpha: false });
    }
  });
});
