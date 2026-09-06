import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t2code/contracts";
import { createModelSelection } from "@t2code/shared/model";

import { getCodexServiceTierOptionValue } from "./codexModelOptions.ts";

it("keeps legacy persisted fast mode selections working", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "fast");
});
