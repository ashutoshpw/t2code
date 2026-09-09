/**
 * FX does not expose a non-interactive structured-output contract through its
 * ACP server. Keep the provider instance complete while failing text
 * generation explicitly until a native helper can preserve the same schema
 * and authentication guarantees as the interactive adapter.
 */
import { FxSettings, TextGenerationError } from "@t2code/contracts";
import * as Effect from "effect/Effect";

import * as TextGeneration from "./TextGeneration.ts";

export const makeFxTextGeneration = Effect.fn("makeFxTextGeneration")(function* (
  _fxSettings: FxSettings,
): Effect.fn.Return<TextGeneration.TextGeneration["Service"]> {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail:
          "FX text generation is not available yet; use an interactive FX thread for this operation.",
      }),
    );

  return {
    generateCommitMessage: (input) => unsupported("generateCommitMessage"),
    generatePrContent: (input) => unsupported("generatePrContent"),
    generateBranchName: (input) => unsupported("generateBranchName"),
    generateThreadTitle: (input) => unsupported("generateThreadTitle"),
  } satisfies TextGeneration.TextGeneration["Service"];
});
