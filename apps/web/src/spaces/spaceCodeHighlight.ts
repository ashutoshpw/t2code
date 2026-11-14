import type { Extension } from "@tiptap/core";
import type { SpaceBlock } from "@t2code/contracts/spaces";
import { isKnownSpaceBlock } from "@t2code/client-runtime/spaces";

import { codeBlockHighlight } from "~/components/composerCodeBlockHighlight";
import { codeLanguageEntry } from "~/composer-code-languages";
import { resolveDiffThemeName } from "~/lib/diffRendering";

/** The language Shiki and the picker use for a stored, free-text `content.language`. */
export function spaceCodeLanguage(block: SpaceBlock | undefined): string {
  const language =
    block && isKnownSpaceBlock(block) && block.type === "code" ? block.content.language : "";
  return codeLanguageEntry(language)?.id ?? language;
}

export function spaceCodeHighlight(): Extension {
  return codeBlockHighlight({
    name: "spaceCodeHighlight",
    isCode: (node) => node.type.name === "code",
    language: (node) => spaceCodeLanguage(node.attrs.block as SpaceBlock | undefined),
    nested: true,
    resolveTheme: () =>
      resolveDiffThemeName(document.documentElement.classList.contains("dark") ? "dark" : "light"),
  });
}
