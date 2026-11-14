import { defineRule, type ESTree } from "@oxlint/plugins";

import grandfathered from "../grandfathered.json" with { type: "json" };
import { isGrandfathered } from "../utils.ts";

const SCRIPTS_TEST_FILE = /(?:^|[\\/])scripts[\\/][^\\/]+\.test\.[cm]?[jt]sx?$/;
const WORKSPACE_RELATIVE_IMPORT = /^(?:\.\.\/)+(?:apps|packages)\//;

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "A test in scripts/ must not import apps/* or packages/* by relative path; move it into the owning workspace package.",
    },
  },
  create(context) {
    if (
      !SCRIPTS_TEST_FILE.test(context.filename) ||
      isGrandfathered(grandfathered.scriptTests, context.filename)
    ) {
      return {};
    }
    const check = (
      node: ESTree.ImportDeclaration | ESTree.ExportAllDeclaration | ESTree.ExportNamedDeclaration,
    ) => {
      const source = node.source?.value;
      if (typeof source !== "string" || !WORKSPACE_RELATIVE_IMPORT.test(source)) return;
      context.report({
        node,
        message: `Tests for code in a workspace package live in that package, not in scripts/. Move this test next to ${source.replace(/^(?:\.\.\/)+/, "")} and import it locally.`,
      });
    };
    return {
      ImportDeclaration: check,
      ExportAllDeclaration: check,
      ExportNamedDeclaration: check,
    };
  },
});
