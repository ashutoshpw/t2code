import { defineRule } from "@oxlint/plugins";

import grandfathered from "../grandfathered.json" with { type: "json" };
import { isGrandfathered } from "../utils.ts";

const MAX_SOURCE_LINES = 800;
const MAX_TEST_LINES = 2000;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const GENERATED_FILE = /\.(?:gen|generated)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;

export default defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: `Fail source files past ${MAX_SOURCE_LINES} lines and test files past ${MAX_TEST_LINES}, unless listed in grandfathered.json.`,
    },
  },
  create(context) {
    const filename = context.filename;
    if (GENERATED_FILE.test(filename) || isGrandfathered(grandfathered.maxLines, filename)) {
      return {};
    }
    const limit = TEST_FILE.test(filename) ? MAX_TEST_LINES : MAX_SOURCE_LINES;
    return {
      "Program:exit"(node) {
        const text = context.sourceCode.text;
        const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        if (lines <= limit) return;
        context.report({
          node,
          message:
            `This file has ${lines} lines, past the ${limit} line limit. ` +
            "Split it by responsibility. Do not add it to oxlint-plugin-t2code/grandfathered.json.",
        });
      },
    };
  },
});
