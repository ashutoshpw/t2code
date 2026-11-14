import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
} from "@t2code/contracts";
import {
  SpaceCommentThreadId,
  SpaceMutationId,
  SpacePageId,
  SpaceReceiptEpoch,
  type SpaceCapability,
} from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createSpacesCommentAtoms } from "./spacesComments.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const operate: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  permissions: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
};
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.success(operate)),
);
const env = EnvironmentId.make("target");
const pageId = SpacePageId.make("page");
const threadId = SpaceCommentThreadId.make("thread");
const supported = { version: 2, limits: {}, features: { comments: true } } as SpaceCapability;
const unsupported = { version: 2, limits: {}, features: {} } as SpaceCapability;

const harness = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const stats = { lists: 0, replies: 0 };
  const transport = {
    client: {
      [WS_METHODS.spacesCommentsList]: () =>
        Effect.sync(() => {
          stats.lists++;
          return {
            pageId,
            commentRevision: 0,
            threads: [],
            nextCursor: null,
            mutationAdmission: {},
          };
        }),
      [WS_METHODS.spacesCommentsReply]: () =>
        Effect.sync(() => {
          stats.replies++;
          return { status: "saved", pageId, commentRevision: 1, commentThreadId: threadId };
        }),
    },
  } as unknown as RpcSession;
  const supervisor = {
    target: { environmentId: env, label: "destination" },
    session: yield* SubscriptionRef.make(Option.some(transport)),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as unknown as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      followStream: (_id: EnvironmentId, stream: Stream.Stream<unknown, unknown, unknown>) =>
        Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const capability = Atom.make<SpaceCapability | undefined>(supported);
  const comments = createSpacesCommentAtoms(runtime, {
    capabilityAtom: () => capability,
    commentLive: () => Atom.make({ commentSeq: 0, resyncSeq: 0 }),
  });
  return { registry, capability, comments, stats };
});

const reply = {
  environmentId: env,
  mutationId: SpaceMutationId.make("m"),
  receiptEpoch: SpaceReceiptEpoch.make("e"),
  commentThreadId: threadId,
  body: [{ text: "x", marks: [] }],
};

describe("spaces comment atoms", () => {
  it.effect("refuses writes without the comments capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, comments, stats } = yield* harness;
        registry.mount(capability);
        registry.set(capability, unsupported);
        const refused = yield* Effect.promise(() =>
          comments.reply.run(registry, { environmentId: env, input: reply }),
        );
        expect(refused._tag).toBe("Failure");
        expect(stats.replies).toBe(0);
      }),
    ),
  );

  it.effect("re-runs a mounted list once after a successful reply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, capability, comments, stats } = yield* harness;
        registry.mount(capability);
        const list = comments.list({
          environmentId: env,
          input: { environmentId: env, pageId, status: "open" },
        });
        registry.mount(list);
        yield* Effect.yieldNow;
        const before = stats.lists;
        expect(before).toBeGreaterThan(0);
        const saved = yield* Effect.promise(() =>
          comments.reply.run(registry, { environmentId: env, input: reply }),
        );
        expect(saved._tag).toBe("Success");
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(stats.replies).toBe(1);
        expect(stats.lists).toBe(before + 1);
      }),
    ),
  );
});
