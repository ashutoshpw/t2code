import { expect, it, vi } from "vite-plus/test";
import { ComposerContextId, EnvironmentId } from "@t2code/contracts";
import { SpacePageId } from "@t2code/contracts/spaces";
const state = vi.hoisted(() => ({
  capability: { version: 2, features: {} as { contextCapture?: true } },
  inline: true,
  read: true,
  captures: 0,
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: () =>
      new Map([
        [
          "env",
          {
            environment: {
              capabilities: { spaces: state.capability, inlineMessageContext: state.inline },
            },
          },
        ],
      ]),
  },
}));
vi.mock("./server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("./session", () => ({ readEnvironmentScope: () => state.read }));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t2code/client-runtime/state/spaces", () => ({
  createSpacesEnvironmentAtoms: () => ({ captureSession: "session", capture: "capture" }),
}));
vi.mock("@t2code/client-runtime/state/runtime", () => ({
  runAtomCommand: async (_registry: unknown, command: unknown) => {
    if (command === "session") return { _tag: "Success", value: () => state };
    state.captures++;
    return { _tag: "Failure" };
  },
}));
import { prepareMobileComposerContext } from "./spaces";
it.each(["missing-flag", "wrong-version", "no-inline", "denied"])(
  "retains selectors and makes no capture RPC for %s",
  async (reason) => {
    state.capability = {
      version: reason === "wrong-version" ? 3 : 2,
      features: reason === "missing-flag" ? {} : { contextCapture: true },
    };
    state.inline = reason !== "no-inline";
    state.read = reason !== "denied";
    state.captures = 0;
    const contextDraft = {
      selectors: [
        {
          version: 1 as const,
          selection: "current" as const,
          kind: "page" as const,
          contextId: ComposerContextId.make("p"),
          label: "Page",
          environmentId: EnvironmentId.make("env"),
          pageId: SpacePageId.make("page"),
          includeChildPages: false,
        },
      ],
      records: [],
    };
    const original = structuredClone(contextDraft);
    await expect(
      prepareMobileComposerContext({
        environmentId: EnvironmentId.make("env"),
        text: "[Page](t2-context://v1/page/p)",
        contextDraft,
        isCurrentDraft: () => true,
      }),
    ).rejects.toThrow();
    expect(state.captures).toBe(0);
    expect(contextDraft).toEqual(original);
  },
);
