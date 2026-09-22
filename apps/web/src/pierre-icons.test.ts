import { assert, describe, it } from "vite-plus/test";

import {
  hasSpecificPierreIconForFileName,
  resolvePierreIconForEntry,
  T2_PIERRE_ICONS,
} from "./pierre-icons";

describe("Pierre file icons", () => {
  it.each(["photo.heic", "photo.heif", "PHOTO.HEIC", "folder/photo.HEIF"])(
    "uses the image icon for %s",
    (name) => {
      assert.equal(resolvePierreIconForEntry(name, "file")?.token, "image");
      assert.isTrue(hasSpecificPierreIconForFileName(name));
    },
  );
  it("uses detected types for extensionless files while keeping known filename icons", () => {
    assert.equal(
      resolvePierreIconForEntry("custom-script", "file", "text/x-python")?.token,
      "python",
    );
    assert.equal(resolvePierreIconForEntry("image", "file", "image/png")?.token, "image");
    assert.equal(
      resolvePierreIconForEntry("Dockerfile", "file", "text/x-shellscript")?.token,
      "docker",
    );
    assert.isNull(resolvePierreIconForEntry("folder.png", "directory", "image/png"));
    assert.equal(
      resolvePierreIconForEntry("unknown", "file", "application/octet-stream")?.token,
      "default",
    );
  });
  it("uses Pierre exact filename and complete-set extension mappings", () => {
    assert.equal(resolvePierreIconForEntry("Dockerfile", "file")?.token, "docker");
    assert.equal(resolvePierreIconForEntry("src/Button.tsx", "file")?.token, "react");
    assert.equal(resolvePierreIconForEntry("vite.config.ts", "file")?.token, "vite");
  });

  it("uses built-in Pierre icons where available", () => {
    assert.equal(resolvePierreIconForEntry("package.json", "file")?.name, "file-tree-builtin-npm");
    assert.equal(
      resolvePierreIconForEntry("config/tsconfig.json", "file")?.name,
      "file-tree-builtin-typescript",
    );
    assert.equal(resolvePierreIconForEntry("CLAUDE.md", "file")?.name, "file-tree-builtin-claude");
    assert.equal(
      resolvePierreIconForEntry("README.md", "file")?.name,
      "file-tree-builtin-markdown",
    );
  });

  it("extends Pierre with T2-specific exact filename icons", () => {
    assert.equal(resolvePierreIconForEntry("AGENTS.md", "file")?.name, "t3-file-icon-agents");
    assert.equal(resolvePierreIconForEntry("pnpm-lock.yaml", "file")?.name, "t3-file-icon-pnpm");
    assert.equal(
      resolvePierreIconForEntry("pnpm-workspace.yaml", "file")?.name,
      "t3-file-icon-pnpm",
    );
  });

  it.each([
    ["pdf", "pdf"],
    ["doc", "word"],
    ["docx", "word"],
    ["odt", "word"],
    ["rtf", "word"],
    ["xls", "spreadsheet"],
    ["xlsx", "spreadsheet"],
    ["ods", "spreadsheet"],
    ["csv", "spreadsheet"],
    ["tsv", "spreadsheet"],
    ["ppt", "slides"],
    ["pptx", "slides"],
    ["odp", "slides"],
    ["epub", "epub"],
  ])("uses the document family icon for %s", (extension, family) => {
    for (const path of [`report.${extension}`, `folder/REPORT.${extension.toUpperCase()}`]) {
      assert.equal(resolvePierreIconForEntry(path, "file")?.name, `t3-file-icon-${family}`);
      assert.isTrue(hasSpecificPierreIconForFileName(path));
    }
  });

  it("ships every custom icon referenced by the extended resolver", () => {
    const customIconNames = new Set(
      [
        ...Object.values(T2_PIERRE_ICONS.byFileName),
        ...Object.values(T2_PIERRE_ICONS.byFileExtension),
      ].filter((name) => name.startsWith("t3-")),
    );
    for (const iconName of customIconNames) {
      assert.include(T2_PIERRE_ICONS.spriteSheet, `id="${iconName}"`);
    }
  });
});
