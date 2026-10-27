import {
  SpaceImageUploads,
  type SpaceImagePorts,
  type SpaceImageStore,
} from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceAssetMetadata, SpacePageTarget } from "@t2code/contracts/spaces";
import { nativeSpaceOriginalCodec, type NativeSpaceOriginal } from "./originals";
import {
  MobileSpaceOriginalFiles,
  withNativeSpaceOriginals,
  type SpaceOriginalFileIO,
} from "./originalFiles";

export function createMobileSpaceUploads(
  ports: Omit<SpaceImagePorts<NativeSpaceOriginal>, "store" | "post" | "original"> & {
    readonly store: SpaceImageStore<NativeSpaceOriginal>;
    readonly io: SpaceOriginalFileIO;
    readonly origin: (environmentId: EnvironmentId) => string;
  },
) {
  const files = new MobileSpaceOriginalFiles(ports.io, ports.store.load, () =>
    ports.newId().replaceAll("-", ""),
  );
  const checkDigest = async (metadata: SpaceAssetMetadata) => {
    const records = await ports.store.load();
    for (const record of records)
      if (record.handle?.assetId === metadata.assetId && metadata.digest !== record.original.sha256)
        throw new Error("Ready asset digest does not match the retained original");
    return metadata;
  };
  const owner = new SpaceImageUploads<NativeSpaceOriginal>({
    ...ports,
    original: nativeSpaceOriginalCodec,
    store: withNativeSpaceOriginals(ports.store, files),
    metadata: async (input) => checkDigest(await ports.metadata(input)),
    finalize: async (input) => checkDigest(await ports.finalize(input)),
    post: (environmentId, relativeUrl, original) => {
      const session = ports.access(environmentId, true).session;
      const origin = ports.origin(environmentId);
      const url = new URL(relativeUrl, origin);
      if (
        !relativeUrl.startsWith("/api/spaces/assets/upload/") ||
        !url.pathname.startsWith("/api/spaces/assets/upload/") ||
        url.origin !== new URL(origin).origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["http:", "https:"].includes(url.protocol)
      )
        throw new Error("Spaces upload origin is unavailable");
      return files.post(original, url.href, () => {
        try {
          return (
            ports.access(environmentId, true).session === session &&
            ports.origin(environmentId) === origin
          );
        } catch {
          return false;
        }
      });
    },
  });
  return {
    owner,
    retain: async (key: SpacePageTarget, uri: string, name: string, current: () => boolean) => {
      await owner.hydrate();
      await ports.connect?.(key.environmentId);
      const access = ports.access(key.environmentId, true);
      if (!current() || !name.trim() || new TextEncoder().encode(name).byteLength > 256)
        throw new Error("Image import destination or name is unavailable");
      return files.retain(
        uri,
        Math.min(10 * 1024 * 1024, access.limits.maxImageBytes),
        async (original) => {
          if (!current() || ports.access(key.environmentId, true).session !== access.session)
            throw new Error("The image destination changed during import");
          await owner.add(key, original, name);
        },
      );
    },
  };
}
export type MobileSpaceUploads = ReturnType<typeof createMobileSpaceUploads>;
