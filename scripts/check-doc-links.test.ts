import { describe, expect, it } from "vite-plus/test";

import {
  extractDocLinks,
  findDocLinkViolations,
  githubHeadingSlug,
  markdownAnchors,
} from "./check-doc-links.ts";

describe("check-doc-links", () => {
  it("extracts relative targets and skips code, external URLs, and reference usages", () => {
    const markdown = [
      "```md",
      "[ignored](./ignored.md)",
      "```",
      "See [docs](./docs.md) and `[inline](./inline.md)`.",
      "![img](./img.png)",
      '[titled](./titled.md "Title")',
      "[spaced](<./with space.md>)",
      "[ref][contract]",
      "[external](https://example.com)",
      "",
      "[contract]: ./contract.ts",
    ].join("\n");

    expect(extractDocLinks(markdown).map((link) => link.target)).toEqual([
      "./docs.md",
      "./img.png",
      "./titled.md",
      "./with space.md",
      "./contract.ts",
    ]);
  });

  it("slugs headings the way GitHub does", () => {
    expect(githubHeadingSlug("T2 Connect troubleshooting")).toBe("t2-connect-troubleshooting");
    expect(githubHeadingSlug("`vp` commands & flags")).toBe("vp-commands--flags");
    expect(githubHeadingSlug("[T2 Connect](./x.md) setup")).toBe("t2-connect-setup");
  });

  it("collects heading and explicit anchors with duplicate suffixes", () => {
    const anchors = markdownAnchors(
      ["# Title", "", "## Setup", "", "## Setup", "", '<a name="custom"></a>', ""].join("\n"),
    );

    expect(anchors.has("title")).toBe(true);
    expect(anchors.has("setup")).toBe(true);
    expect(anchors.has("setup-1")).toBe(true);
    expect(anchors.has("custom")).toBe(true);
  });

  it("flags missing targets and missing anchors", () => {
    const files = new Map<string, string>([
      ["README.md", "[guide](./docs/guide.md)\n[bad](./docs/missing.md)\n"],
      [
        "docs/guide.md",
        [
          "# Guide",
          "",
          "## Setup",
          "",
          "[back](../README.md#top)",
          "[anchor](./other.md#deep-dive)",
          "[missing anchor](./other.md#nope)",
        ].join("\n"),
      ],
      ["docs/other.md", "## Deep Dive\n"],
    ]);

    expect(findDocLinkViolations(files, (path) => files.has(path))).toEqual([
      {
        file: "docs/guide.md",
        line: 5,
        target: "../README.md#top",
        reason: 'missing anchor "#top"',
      },
      {
        file: "docs/guide.md",
        line: 7,
        target: "./other.md#nope",
        reason: 'missing anchor "#nope"',
      },
      { file: "README.md", line: 2, target: "./docs/missing.md", reason: "target does not exist" },
    ]);
  });

  it("accepts external links, directories, and vendored targets", () => {
    const files = new Map<string, string>([
      [
        "docs/a.md",
        [
          "[web](https://example.com)",
          "[mail](mailto:hello@example.com)",
          "[dir](./subdir)",
          "[vendored](../.repos/effect-smol/README.md)",
          "[self](#local-heading)",
          "",
          "## Local heading",
        ].join("\n"),
      ],
    ]);

    expect(findDocLinkViolations(files, (path) => path === "docs/subdir")).toEqual([]);
  });
});
