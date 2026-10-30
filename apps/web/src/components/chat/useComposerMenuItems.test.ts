import { expect, it, vi } from "vite-plus/test";
import { ComposerContextId, EnvironmentId, ProviderDriverKind } from "@t2code/contracts";
import { SpaceBlockId, SpaceCursor, SpaceId, SpacePageId } from "@t2code/contracts/spaces";
import { SpaceReferenceController, type SpaceSearchWindow } from "@t2code/client-runtime/spaces";
const state = vi.hoisted(() => ({
  window: null as SpaceSearchWindow | null,
  loading: false,
  includeChildPages: false,
  next: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <A>(initial: A | (() => A)) =>
    typeof initial === "function"
      ? [(initial as () => A)(), () => {}]
      : [
          state.includeChildPages,
          (next: boolean) => {
            state.includeChildPages = next;
          },
        ],
}));
vi.mock("../../spaces/useSpaceReferences", () => ({
  useSpaceContextSearch: () => state,
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentIdentities: () => [],
  useEnvironmentMachines: () => new Map(),
}));
vi.mock("~/state/peerLinks", () => ({
  offersLinkedEnvironmentsAtom: () => null,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => false,
}));
vi.mock("~/state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("~/state/queries", () => ({
  useDebouncedValue: <A>(value: A) => value,
  useThreadSearch: () => {},
  useComposerPathSearch: () => ({
    entries: [{ kind: "file", path: "word.ts" }],
    searchedTarget: null,
    isPending: false,
  }),
}));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { detail: vi.fn() },
  usePullRequestList: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, isPending: false }),
}));
import { useComposerMenuItems } from "./useComposerMenuItems";
const environmentId = EnvironmentId.make("env");
function setup() {
  state.window = null;
  state.loading = false;
  state.includeChildPages = false;
  state.next.mockReset();
  state.retry.mockReset();
}
function menu() {
  return useComposerMenuItems({
    composerTrigger: { kind: "path", query: "word", rangeStart: 0, rangeEnd: 5 },
    environmentId,
    linkedEnvironments: new Map(),
    gitCwd: "/project",
    activeThreadId: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    threadPullRequests: [],
    planModeUiEnabled: false,
    compactSlashCommandAvailable: false,
    selectedProvider: ProviderDriverKind.make("codex"),
    selectedProviderSkills: [],
    selectedProviderSlashCommands: [],
    showSkillsInSlashMenu: false,
    questionAttachmentTarget: null,
  });
}
it("offers Page and Block selectors alongside files and refuses obsolete choices", async () => {
  setup();
  const session = {};
  const page = {
    id: SpacePageId.make("page"),
    spaceId: SpaceId.make("space"),
    title: "Word",
    revision: 1,
    rootOrder: "a",
    createdAt: "2026-10-26T00:00:00Z",
    updatedAt: "2026-10-26T00:00:00Z",
  };
  const controller = new SpaceReferenceController({
    environmentId,
    access: () => ({
      session,
      canRead: true,
      inlineContext: true,
      sourceVersion: 0,
      capability: { version: 2, features: { search: true, contextCapture: true } },
    }),
    search: async () => ({
      catalogRevision: 1,
      items: [
        { page, snippet: "title" },
        { page, blockId: SpaceBlockId.make("block"), snippet: "word body" },
      ],
      nextCursor: SpaceCursor.make("more"),
    }),
    resolve: async () => ({ status: "deleted" }),
  });
  state.window = await controller.search("word");
  const items = menu().items;
  const choices = items.filter((item) => item.type === "space-context");
  expect(choices).toHaveLength(2);
  expect(
    choices.map((item, index) => item.select(ComposerContextId.make(`selected-${index}`))?.kind),
  ).toEqual(["page", "block"]);
  expect(items.some((item) => item.type === "path")).toBe(true);
  expect(
    items.some((item) => item.type === "space-action" && item.label === "More Spaces results"),
  ).toBe(true);
  expect(
    choices.map((item) => item.select(ComposerContextId.make("default"))?.includeChildPages),
  ).toEqual([false, false]);
  const toggle = menu().items.find((item) => item.id === "space:include-children");
  if (toggle?.type !== "space-action") throw Error("Missing child-page option");
  toggle.perform();
  const optedIn = menu().items.filter((item) => item.type === "space-context");
  expect(optedIn[0]?.select(ComposerContextId.make("child-page"))?.includeChildPages).toBe(true);
  expect(
    menu()
      .items.filter((item) => item.type === "space-context")[1]
      ?.select(ComposerContextId.make("next-default"))?.includeChildPages,
  ).toBe(false);
  toggle.perform();
  expect(
    menu()
      .items.filter((item) => item.type === "space-context")[1]
      ?.select(ComposerContextId.make("child-block"))?.includeChildPages,
  ).toBe(true);
  controller.invalidate();
  expect(choices[0]?.select(ComposerContextId.make("late"))).toBeNull();
  state.loading = true;
  expect(menu().items.some((item) => item.type === "space-notice")).toBe(false);
  state.loading = false;
});
it("shows building as an explicit retry action instead of fake results", () => {
  setup();
  state.window = { status: "building" };
  const building = menu().items;
  expect(building.some((item) => item.type === "space-context")).toBe(false);
  const retry = building.find((item) => item.type === "space-action");
  if (retry?.type !== "space-action") throw Error("Missing retry");
  retry.perform();
  expect(state.retry).toHaveBeenCalledOnce();
});
