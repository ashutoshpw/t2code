import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentId, WS_METHODS } from "../packages/contracts/src/index.ts";
import { EnvironmentRegistry } from "../packages/client-runtime/src/connection/registry.ts";
import { EnvironmentSupervisor } from "../packages/client-runtime/src/connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
} from "../packages/client-runtime/src/connection/model.ts";
import {
  MobileSpaceImageBudget,
  MobileSpaceImageViewer,
} from "../apps/mobile/src/features/spaces/media.ts";
import {
  createSpacesMediaReads,
  createSpacesReferenceRead,
} from "../apps/mobile/src/rpc/spacesMedia.ts";

it.effect(
  "cancels the actual media signer and holds the global viewer permit until RPC cancellation cleanup ends across distinct assets",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("media-query-owner");
      let active = 0,
        maximum = 0,
        calls = 0;
      let allowed = true;
      const assertRead = () => {
        if (!allowed) throw new Error("Read permission withdrawn");
      };
      const gates = [];
      let entered = Promise.withResolvers();
      const state = yield* SubscriptionRef.make({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
        generation: 1,
        attempt: 1,
      });
      const rpc = {
        client: {
          [WS_METHODS.spacesAssetsGet]: (input) =>
            Effect.succeed({
              assetId: input.assetId,
              digest: "digest",
              byteSize: 1,
              mimeType: "image/png",
              name: "original.png",
              imageDimensions: { width: 1, height: 1 },
            }),
          [WS_METHODS.spacesReferencesResolve]: () => Effect.succeed({ status: "deleted" }),
          [WS_METHODS.assetsCreateUrl]: () =>
            Effect.suspend(() => {
              const gate = {
                started: Promise.withResolvers(),
                canceling: Promise.withResolvers(),
                cleanup: Promise.withResolvers(),
              };
              gates.push(gate);
              entered.resolve();
              active++;
              calls++;
              maximum = Math.max(active, maximum);
              gate.started.resolve();
              return Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.promise(async () => {
                    gate.canceling.resolve();
                    await gate.cleanup.promise;
                    active--;
                  }),
                ),
              );
            }),
        },
      };
      const session = yield* SubscriptionRef.make(Option.some(rpc));
      const supervisor = {
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Media test",
          httpBaseUrl: "https://selected.example",
          wsBaseUrl: "wss://selected.example",
        }),
        state,
        session,
      };
      supervisor.prepared = yield* SubscriptionRef.make(
        Option.some({
          environmentId,
          label: supervisor.target.label,
          target: supervisor.target,
          httpBaseUrl: "https://selected.example",
          socketUrl: "wss://selected.example/ws",
          httpAuthorization: null,
        }),
      );
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry, {
            run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
            followStream: (_id, stream) =>
              Stream.provideService(stream, EnvironmentSupervisor, supervisor),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    authenticated: true,
                    auth: {
                      policy: "remote-reachable",
                      bootstrapMethods: [],
                      sessionMethods: [],
                      sessionCookieName: "fixture-session",
                    },
                    scopes: ["orchestration:read"],
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      const registry = AtomRegistry.make();
      const budget = new MobileSpaceImageBudget();
      const capability = {
        version: 2,
        features: { assets: true },
        limits: { assets: { maxImageBytes: 10 * 1024 * 1024, maxImagePixels: 24000000 } },
      };
      const readers = [];
      const make = () => {
        const reads = createSpacesMediaReads(runtime, registry, environmentId, assertRead);
        const viewer = new MobileSpaceImageViewer({
          ...reads,
          budget,
          now: () => 0,
          access: () => ({
            capability,
            httpBaseUrl: "https://selected.example",
            current: () => true,
          }),
          share: async () => {},
        });
        readers.push(viewer);
        return viewer;
      };
      const block = (id) => ({
        id: `block-${id}`,
        type: "image",
        version: 1,
        parentId: null,
        order: "a",
        content: { assetId: id },
      });
      yield* Effect.promise(async () => {
        try {
          const first = make(),
            next = make();
          for (const index of [0, 1, 2]) {
            entered = Promise.withResolvers();
            const viewer = index === 0 ? first : next;
            const opening = viewer.open(block(`asset-${index}`), () => true);
            await entered.promise;
            const gate = gates[index];
            viewer.close();
            const outcome = await Promise.race([
              opening.then(() => "caller-settled"),
              gate.canceling.promise.then(() => "canceling"),
            ]);
            expect(outcome).toBe("canceling");
            const denied = make();
            await denied.open(block(`refused-${index}`), () => true);
            expect(calls).toBe(index + 1);
            expect(active).toBe(1);
            gate.cleanup.resolve();
            await opening;
            expect(active).toBe(0);
          }
          expect(maximum).toBe(1);
          expect(calls).toBe(3);
          const reference = createSpacesReferenceRead(runtime, registry, assertRead);
          await expect(
            reference(
              { environmentId, target: { kind: "page", pageId: "deleted-source" } },
              new AbortController().signal,
            ),
          ).resolves.toEqual({ status: "deleted" });
          allowed = false;
          const reads = createSpacesMediaReads(runtime, registry, environmentId, assertRead);
          await expect(
            reads.mint("denied", "inline", new AbortController().signal),
          ).rejects.toThrow("Read permission withdrawn");
          await expect(reads.metadata("denied", new AbortController().signal)).rejects.toThrow(
            "Read permission withdrawn",
          );
          expect(calls).toBe(3);
          expect(active).toBe(0);
        } finally {
          for (const viewer of readers) viewer.close();
          for (const gate of gates) gate.cleanup.resolve();
          registry.dispose();
        }
      });
    }),
);
