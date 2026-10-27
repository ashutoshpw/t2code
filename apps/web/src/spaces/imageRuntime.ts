import {
  type EnvironmentId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "@t2code/contracts";
import {
  SpaceImageUploads,
  SpaceImagePreviewBudget,
  imageAssetId,
} from "@t2code/client-runtime/spaces";
import { resolveAssetUrl } from "@t2code/client-runtime/state/assets";
import {
  executeAtomQuery,
  runAtomCommand,
  type AtomCommandResult,
} from "@t2code/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { type Atom, type AtomRegistry } from "effect/reactivity";
import { spacesEnvironment } from "../state/spaces";
import { environmentSession, sessionHasScope } from "../state/session";
import { environmentPresentations } from "../state/presentation";
import { uploadBytes } from "../lib/uploadBytes";
import { randomUUID } from "../lib/utils";
import { createSpaceImageStore } from "./imageDraftStore";
import { createSpaceDraftStore } from "./draftStore";
import { spaceDocuments } from "./sessionRuntime";

const owners = new WeakMap<AtomRegistry.AtomRegistry, SpaceImageUploads>();
const previews = new WeakMap<AtomRegistry.AtomRegistry, SpaceImagePreviewBudget>();
export function spaceImagePreviews(registry: AtomRegistry.AtomRegistry) {
  let owner = previews.get(registry);
  if (!owner) {
    owner = new SpaceImagePreviewBudget();
    previews.set(registry, owner);
  }
  return owner;
}
function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
export function spaceImages(registry: AtomRegistry.AtomRegistry): SpaceImageUploads {
  const previous = owners.get(registry);
  if (previous) return previous;
  const sessions = new Map<EnvironmentId, () => object | null>();
  const connecting = new Map<EnvironmentId, Promise<void>>();
  const drafts = createSpaceDraftStore();
  async function connect(environmentId: EnvironmentId) {
    if (sessions.get(environmentId)?.()) return;
    let pending = connecting.get(environmentId);
    if (!pending) {
      pending = runAtomCommand(
        registry,
        spacesEnvironment.captureSession,
        { environmentId, input: undefined },
        { reportFailure: false },
      )
        .then((result) => {
          sessions.set(environmentId, unwrap(result));
        })
        .finally(() => {
          connecting.delete(environmentId);
        });
      connecting.set(environmentId, pending);
    }
    await pending;
  }
  function access(environmentId: EnvironmentId, write: boolean) {
    const environment = registry.get(environmentPresentations.presentationAtom(environmentId));
    const grants = registry.get(environmentSession.sessionStateAtom(environmentId));
    const capability = environment?.serverConfig?.environment.capabilities.spaces;
    const session = sessions.get(environmentId)?.();
    if (
      !session ||
      environment?.connection.phase !== "connected" ||
      capability?.version !== 2 ||
      capability.features?.assets !== true ||
      !capability.limits.assets ||
      !sessionHasScope(grants, AuthOrchestrationReadScope) ||
      (write && !sessionHasScope(grants, AuthOrchestrationOperateScope))
    )
      throw new Error(
        "Images require the current destination connection, assets support and permission",
      );
    return { session, limits: capability.limits.assets };
  }
  const read = async <A, E>(
    environmentId: EnvironmentId,
    query: Atom.Atom<import("effect/reactivity").AsyncResult.AsyncResult<A, E>>,
  ) => {
    access(environmentId, false);
    return unwrap(await executeAtomQuery(registry, query, { refresh: true, reportFailure: false }));
  };
  const owner = new SpaceImageUploads({
    store: createSpaceImageStore(),
    connect,
    access,
    newId: randomUUID,
    changed: () => spaceDocuments(registry).refreshAccess(),
    draft: (key) => drafts.load(key),
    mint: async (input) => {
      access(input.environmentId, true);
      return unwrap(
        await spacesEnvironment.createImageUpload.run(registry, {
          environmentId: input.environmentId,
          input,
        }),
      );
    },
    finalize: async (input) => {
      access(input.environmentId, true);
      return unwrap(
        await spacesEnvironment.finalizeImageUpload.run(registry, {
          environmentId: input.environmentId,
          input,
        }),
      );
    },
    status: (input) =>
      read(
        input.environmentId,
        spacesEnvironment.imageUpload({ environmentId: input.environmentId, input }),
      ),
    metadata: (input) =>
      read(
        input.environmentId,
        spacesEnvironment.imageMetadata({ environmentId: input.environmentId, input }),
      ),
    post: (environmentId, relativeUrl, original, name) => {
      access(environmentId, true);
      const connection = registry.get(
        environmentSession.preparedConnectionValueAtom(environmentId),
      );
      const url = Option.isSome(connection)
        ? resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl)
        : null;
      if (
        !url ||
        !relativeUrl.startsWith("/api/spaces/assets/upload/") ||
        !new URL(url).pathname.startsWith("/api/spaces/assets/upload/") ||
        new URL(url).search ||
        new URL(url).hash
      )
        throw new Error("Image upload destination is unavailable");
      return uploadBytes({
        url,
        file: new File([original], name, { type: original.type }),
        mimeType: original.type,
        onProgress: () => {},
      });
    },
    saved: async (key, blockId, assetId) => {
      await connect(key.environmentId);
      const session = access(key.environmentId, false).session;
      const metadata = await read(
        key.environmentId,
        spacesEnvironment.page({ environmentId: key.environmentId, input: key }),
      );
      const window = await read(
        key.environmentId,
        spacesEnvironment.blocks({
          environmentId: key.environmentId,
          input: { ...key, revision: metadata.page.revision, limit: 100 },
        }),
      );
      return (
        access(key.environmentId, false).session === session &&
        window.revision === metadata.page.revision &&
        window.blocks.some((b) => b.id === blockId && imageAssetId(b) === assetId)
      );
    },
  });
  owners.set(registry, owner);
  return owner;
}
