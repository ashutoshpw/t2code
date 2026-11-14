import {
  SpacesUnavailableError,
  type SpaceCapability,
  type SpaceCommentDispatchInput,
  type SpacePageId,
} from "@t2code/contracts/spaces";
import { WS_METHODS, type EnvironmentId } from "@t2code/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { requestGuarded } from "../rpc/client.ts";
import { commentsSupported } from "../spaces/comments.ts";
import type { SpacePageCommentSignal } from "../spaces/livePage.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const keyOf = (environmentId: EnvironmentId, id: string) => JSON.stringify([environmentId, id]);

/**
 * Comments per page. Reads refresh on the page's comment signal and on this client's own writes;
 * neither touches the document's signal, so comment traffic never reloads an open page.
 */
export function createSpacesCommentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  options: {
    readonly capabilityAtom?: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<SpaceCapability | undefined>;
    readonly commentLive: (
      environmentId: EnvironmentId,
      pageId: SpacePageId,
    ) => Atom.Atom<SpacePageCommentSignal>;
  },
) {
  const localChanged = Atom.family((_key: string) => Atom.make(0));
  // Learned from answers: a thread lookup does not know its page until the server says.
  const threadPages = Atom.family((_key: string) =>
    Atom.make<SpacePageId | undefined>(undefined).pipe(Atom.keepAlive),
  );
  const trigger = Atom.family((key: string) => {
    const [environmentId, id, byThread] = JSON.parse(key) as [EnvironmentId, string, boolean];
    return Atom.make((get) => {
      const pageId = byThread ? get(threadPages(keyOf(environmentId, id))) : (id as SpacePageId);
      if (pageId === undefined) return 0;
      const live = get(options.commentLive(environmentId, pageId));
      return live.commentSeq + live.resyncSeq + get(localChanged(keyOf(environmentId, pageId)));
    });
  });
  const bump = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    pageId: SpacePageId,
  ) => registry.update(localChanged(keyOf(environmentId, pageId)), (count) => count + 1);

  const gate = <A, F, Req>(
    environmentId: EnvironmentId,
    registry: AtomRegistry.AtomRegistry,
    request: Effect.Effect<A, F, Req>,
  ): Effect.Effect<A, F | SpacesUnavailableError, Req> =>
    commentsSupported(
      options.capabilityAtom ? registry.get(options.capabilityAtom(environmentId)) : undefined,
    )
      ? request
      : Effect.fail(new SpacesUnavailableError({ stage: "settings" }));

  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:spaces:comments",
    tag: WS_METHODS.spacesCommentsList,
    idleTtlMs: 0,
    staleTimeMs: 0,
    refreshTrigger: ({ environmentId, input }) =>
      trigger(
        "commentThreadId" in input
          ? JSON.stringify([environmentId, input.commentThreadId, true])
          : JSON.stringify([environmentId, input.pageId, false]),
      ),
    onAnswer: ({ environmentId, input }, value, registry) =>
      Effect.sync(() => {
        if ("commentThreadId" in input)
          registry.set(threadPages(keyOf(environmentId, input.commentThreadId)), value.pageId);
      }),
  });

  return {
    list,
    create: createEnvironmentRpcCommand(runtime, {
      label: "spaces.comments.create",
      tag: WS_METHODS.spacesCommentsCreate,
      execute: (input, registry) =>
        gate(input.environmentId, registry, requestGuarded(WS_METHODS.spacesCommentsCreate, input)),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => bump(registry, target.environmentId, result.pageId)),
    }),
    reply: createEnvironmentRpcCommand(runtime, {
      label: "spaces.comments.reply",
      tag: WS_METHODS.spacesCommentsReply,
      execute: (input, registry) =>
        gate(input.environmentId, registry, requestGuarded(WS_METHODS.spacesCommentsReply, input)),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => bump(registry, target.environmentId, result.pageId)),
    }),
    edit: createEnvironmentRpcCommand(runtime, {
      label: "spaces.comments.edit",
      tag: WS_METHODS.spacesCommentsEdit,
      execute: (input, registry) =>
        gate(input.environmentId, registry, requestGuarded(WS_METHODS.spacesCommentsEdit, input)),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => bump(registry, target.environmentId, result.pageId)),
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "spaces.comments.delete",
      tag: WS_METHODS.spacesCommentsDelete,
      execute: (input, registry) =>
        gate(input.environmentId, registry, requestGuarded(WS_METHODS.spacesCommentsDelete, input)),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => bump(registry, target.environmentId, result.pageId)),
    }),
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "spaces.comments.resolve",
      tag: WS_METHODS.spacesCommentsResolve,
      execute: (input, registry) =>
        gate(
          input.environmentId,
          registry,
          requestGuarded(WS_METHODS.spacesCommentsResolve, input),
        ),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => bump(registry, target.environmentId, result.pageId)),
    }),
    reopen: createEnvironmentRpcCommand(runtime, {
      label: "spaces.comments.reopen",
      tag: WS_METHODS.spacesCommentsReopen,
      execute: (input, registry) =>
        gate(input.environmentId, registry, requestGuarded(WS_METHODS.spacesCommentsReopen, input)),
      onSuccess: (target, registry, result) =>
        Effect.sync(() => bump(registry, target.environmentId, result.pageId)),
    }),
    /** `pageId` only says which page's comments to refresh; the request itself is `SpaceCommentDispatchInput`. */
    dispatch: createEnvironmentRpcCommand(runtime, {
      label: "spaces.comments.dispatch",
      tag: WS_METHODS.spacesCommentsDispatch,
      execute: (input: SpaceCommentDispatchInput & { readonly pageId: SpacePageId }, registry) => {
        const { pageId: _pageId, ...request } = input;
        return gate(
          input.environmentId,
          registry,
          requestGuarded(WS_METHODS.spacesCommentsDispatch, request),
        );
      },
      onSuccess: (target, registry) =>
        Effect.sync(() => bump(registry, target.environmentId, target.input.pageId)),
    }),
  };
}

export type SpacesCommentAtoms = ReturnType<typeof createSpacesCommentAtoms>;
