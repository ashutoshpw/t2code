import { SpaceBlockId, SpacePageId, SpaceViewId } from "@t2code/contracts/spaces";
import { describe, expect, it } from "vite-plus/test";

import { formLinkUrl } from "./spacePageShareDialogState";

const form = { blockId: SpaceBlockId.make("b1"), viewId: SpaceViewId.make("v1") };
const page = SpacePageId.make("p1");

describe("formLinkUrl", () => {
  it("puts the form query before the credential fragment", () => {
    expect(formLinkUrl("https://host.example/shared#tok", page, form)).toBe(
      "https://host.example/shared?page=p1&block=b1&view=v1&form=1#tok",
    );
  });

  it("extends an existing query and works without a fragment", () => {
    expect(formLinkUrl("https://host.example/shared?x=1", page, form)).toBe(
      "https://host.example/shared?x=1&page=p1&block=b1&view=v1&form=1",
    );
  });
});
