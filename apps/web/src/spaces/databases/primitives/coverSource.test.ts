import { describe, expect, it } from "vite-plus/test";
import type { SpaceCardPreview } from "@t2code/contracts/spaces";

import { coverOf } from "./coverSource";

const property: SpaceCardPreview = { kind: "property", propertyId: "files" as never };
const row = (files: unknown, cover?: { url?: string }) => ({ cells: { files }, cover });

describe("coverOf", () => {
  it("takes the first image of a files property, else the first url", () => {
    expect(
      coverOf(
        row([
          { name: "notes.pdf", url: "https://x.test/notes.pdf" },
          { name: "a.PNG", url: "https://x.test/a.PNG?v=1" },
        ]),
        property,
      ),
    ).toEqual({ kind: "url", url: "https://x.test/a.PNG?v=1" });
    expect(coverOf(row([{ name: "doc", url: "https://x.test/doc" }]), property)).toEqual({
      kind: "url",
      url: "https://x.test/doc",
    });
  });

  it("maps an uploaded asset and refuses unsafe urls", () => {
    expect(coverOf(row([{ name: "a.png", assetId: "asset-1" }]), property)).toEqual({
      kind: "asset",
      assetId: "asset-1",
    });
    expect(coverOf(row([{ name: "a.png", url: "javascript:alert(1)" }]), property)).toBeNull();
  });

  it("has no cover for none, page_cover, empty cells or malformed values", () => {
    expect(
      coverOf(row([{ name: "a.png", url: "https://x.test/a.png" }]), { kind: "none" }),
    ).toBeNull();
    expect(coverOf(row([]), { kind: "page_cover" })).toBeNull();
    expect(coverOf(row([]), property)).toBeNull();
    expect(coverOf(row("nope"), property)).toBeNull();
    expect(coverOf(row(undefined), undefined)).toBeNull();
  });

  it("reads the row's first page image for page_content", () => {
    expect(coverOf(row([], { url: "https://x.test/p.png" }), { kind: "page_content" })).toEqual({
      kind: "url",
      url: "https://x.test/p.png",
    });
    expect(coverOf(row([]), { kind: "page_content" })).toBeNull();
  });
});
