import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import type { SpaceOriginalFileIO } from "./originalFiles";
import type { NativeSpaceMediaKind } from "./originals";

export function createExpoSpaceOriginalFileIO(): SpaceOriginalFileIO {
  const fileSystem = () => import("expo-file-system");
  return {
    uri: (slot, partial) => `spaces-original:${slot}:${partial ? "part" : "original"}`,
    reader: async (uri) => {
      const { File, FileMode } = await fileSystem();
      const file = uri.startsWith("spaces-original:") ? await resolve(uri) : new File(uri);
      const handle = file.open(FileMode.ReadOnly);
      return { read: (bytes) => handle.readBytes(bytes), close: () => handle.close() };
    },
    writer: async (uri) => {
      const { File, Directory, Paths, FileMode } = await fileSystem();
      const [slot, name] = owned(uri);
      const directory = new Directory(Paths.document, "t2-spaces-originals-v1", slot);
      directory.create({ idempotent: true, intermediates: true });
      const file = new File(directory, name);
      file.create();
      const handle = file.open(FileMode.WriteOnly);
      return { write: (bytes) => handle.writeBytes(bytes), close: () => handle.close() };
    },
    inspect: async (uri, maxBytes) => {
      const file = await resolve(uri);
      const size = file.size;
      if (!Number.isSafeInteger(size) || size === null || size < 1 || size > maxBytes)
        throw new Error("Retained Spaces original is missing or empty");
      return { size, sha256: await file.digest("SHA-256") };
    },
    remove: async (uri) => {
      const file = await resolve(uri);
      if (file.exists) file.delete();
    },
    move: async (source, destination) => {
      const file = await resolve(source);
      await file.move(await resolve(destination));
    },
    upload: async (uri, url, headers, signal) => {
      const { UploadType } = await fileSystem();
      const file = await resolve(uri);
      const task = file.createUploadTask(url, {
        httpMethod: "POST",
        uploadType: UploadType.BINARY_CONTENT,
        headers,
        signal,
      });
      try {
        const result = await task.uploadAsync();
        if (result.status < 200 || result.status >= 300)
          throw new Error(`Spaces byte upload failed (${result.status}); retain its exact intent`);
      } finally {
        task.release();
      }
    },
  };
}
function owned(uri: string) {
  const match = /^spaces-original:([01]):(part|original)$/.exec(uri);
  if (!match) throw new Error("Unsupported Spaces original location");
  return [match[1]!, match[2] === "part" ? "original.part" : "original"] as const;
}
async function resolve(uri: string) {
  const { File, Paths } = await import("expo-file-system");
  const [slot, name] = owned(uri);
  return new File(Paths.document, "t2-spaces-originals-v1", slot, name);
}

export async function pickNativeSpaceMediaFile(kind: NativeSpaceMediaKind) {
  const { getDocumentAsync } = await import("expo-document-picker");
  const endHandoff = beginForegroundHandoff();
  try {
    const result = await getDocumentAsync({
      multiple: false,
      copyToCacheDirectory: false,
      base64: false,
      type:
        kind === "image"
          ? ["image/png", "image/jpeg", "image/gif", "image/webp"]
          : kind === "pdf"
            ? ["application/pdf"]
            : ["video/mp4", "video/webm"],
    });
    if (result.canceled) return null;
    if (result.assets.length !== 1) throw new Error("Choose one original file");
    return result.assets[0]!;
  } finally {
    endHandoff();
  }
}
