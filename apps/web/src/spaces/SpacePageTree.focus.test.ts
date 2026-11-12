// @effect-diagnostics nodeBuiltinImport:off -- executes installed scroll ownership functions without a DOM.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { SpacePageFocusOwner } from "./SpacePageTree.focus";
import { spacePageTreeRows, type SpacePageTreeRow } from "./SpacePageTree.logic";

function installedScrolls(bundle: string) {
  const source = NodeFS.readFileSync(
    new URL(`../../node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const section = (from: string, to: string) =>
    source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  const tasks = new Map<string, () => void>();
  const rows = spacePageTreeRows([
    { parentPageId: null, path: [], cursor: undefined, data: null, pending: true, error: null },
  ]);
  const dispatched: string[] = [];
  const state = {
    props: { data: rows },
    didDataChange: false,
    scrollingTo: undefined as { index?: number } | undefined,
    pendingScrollResolve: undefined as (() => void) | undefined,
    scrollHistory: [] as number[],
    endFollowInterrupted: false,
    scrollAdjustHandler: { commitPendingAdjust: () => {} },
    refScroller: { current: {} },
    scheduledWork: {
      cancel: (name: string) => tasks.delete(name),
      has: (name: string) => tasks.has(name),
      frame: (callback: () => void, name: string) => tasks.set(name, callback),
    },
  };
  const ctx = { state };
  const core = NodeVM.runInNewContext(
    `${section("function cancelScrollCompletionChecks(", "// src/core/deferredPublicOnScroll.ts")}
     ${section("function finishScrollTo(", "\n// src/")}
     ${section("// src/core/scrollRequestTracker.ts", "\n// src/")}
     ${section("function createImperativeHandle(", "\n// src/")}
     ({ create: createImperativeHandle, finish: finishScrollTo })`,
    {
      Date: { now: () => 0 },
      PlatformAdjustBreaksScroll: false,
      supersedeInitialScroll: () => {},
      recalculateSettledScroll: () => {},
      set$: () => {},
      interruptMaintainScrollAtEnd: (context: typeof ctx) => {
        context.state.endFollowInterrupted = true;
      },
      cancelScroll: () => {},
      scrollToIndex: (_ctx: typeof ctx, target: { index: number }) => {
        dispatched.push(rows[target.index]!.key);
        state.scrollingTo = { index: target.index };
      },
      scrollTo: () => {
        dispatched.push("hold-offset");
        state.scrollingTo = {};
      },
    },
  ) as {
    create: (context: typeof ctx) => {
      scrollToItem: (input: { item: SpacePageTreeRow; animated: boolean }) => Promise<void>;
      scrollToOffset: (input: { offset: number; animated: boolean }) => Promise<void>;
    };
    finish: (context: typeof ctx) => void;
  };
  const api = core.create(ctx);
  return {
    rows,
    state,
    api,
    dispatched,
    finish: () => core.finish(ctx),
    readinessQueued: () => tasks.has("imperativeScrollReady"),
    queueCompletion: () => tasks.set("platformScrollCompletion", () => core.finish(ctx)),
    drainCompletion: () => {
      const task = tasks.get("platformScrollCompletion");
      tasks.delete("platformScrollCompletion");
      task?.();
    },
    completionQueued: () => tasks.has("platformScrollCompletion"),
    ready: () => {
      const task = tasks.get("imperativeScrollReady");
      tasks.delete("imperativeScrollReady");
      if (!task) throw new Error("No deferred scroll readiness task.");
      task();
    },
  };
}

describe.each([
  "react.js",
  "react.mjs",
  "react-native.web.js",
  "react-native.web.mjs",
  "react-native.js",
  "react-native.mjs",
])("imperative scroll execution ownership (%s)", (bundle) => {
  it("does not let an old target complete a deferred replacement or detach its cancellation", async () => {
    const list = installedScrolls(bundle);
    const item = list.rows[0]!;
    const focused: string[] = [];
    const epoch = {};
    const owner = new SpacePageFocusOwner({ epoch: () => epoch, pending: () => {} });
    owner.attach({
      rows: () => list.rows,
      scrollToItem: (row) => list.api.scrollToItem({ item: row, animated: false }),
      cancelScroll: () => {
        void list.api.scrollToOffset({ offset: 0, animated: false });
      },
      containsFocus: () => true,
      focus: (key) => focused.push(key),
    });
    try {
      const old = list.api.scrollToItem({ item, animated: false });
      list.queueCompletion();
      list.state.didDataChange = true;
      const replacement = owner.request(item.key);
      expect(list.readinessQueued()).toBe(true);
      // The queued completion is the replaced target's. Draining it retires that
      // target and leaves the replacement waiting on its own readiness frames.
      expect(list.completionQueued()).toBe(true);
      list.drainCompletion();
      expect(list.state.scrollingTo).toBeUndefined();
      expect(list.readinessQueued()).toBe(true);
      await old;
      expect(focused).toEqual([]);
      expect(list.dispatched).toEqual([item.key]);
      list.state.didDataChange = false;
      list.ready();
      list.ready();
      expect(list.dispatched).toEqual([item.key, item.key]);
      list.finish();
      await replacement;
      expect(focused).toEqual([item.key]);

      const active = list.api.scrollToItem({ item, animated: false });
      list.state.didDataChange = true;
      const canceled = owner.request(item.key);
      list.finish();
      await active;
      expect(focused).toEqual([item.key]);
      owner.cancel();
      await canceled;
      list.state.didDataChange = false;
      list.ready();
      list.ready();
      expect(list.dispatched).toEqual([item.key, item.key, item.key, "hold-offset"]);
      list.finish();
      expect(focused).toEqual([item.key]);
      expect(list.readinessQueued()).toBe(false);
    } finally {
      owner.attach(null);
    }
  });
});
