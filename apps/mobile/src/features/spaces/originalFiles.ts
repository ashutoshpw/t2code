import type { SpaceImageStore } from "@t2code/client-runtime/spaces";
import { nativeSpaceOriginalCodec, type NativeSpaceOriginal } from "./originals";

export interface SpaceOriginalFileIO {
  readonly uri: (slot: 0 | 1, partial: boolean) => string;
  readonly reader: (
    uri: string,
  ) => Promise<{ read: (bytes: number) => Promise<Uint8Array>; close: () => void }>;
  readonly writer: (
    uri: string,
  ) => Promise<{ write: (bytes: Uint8Array) => Promise<void>; close: () => void }>;
  readonly inspect: (uri: string, maxBytes: number) => Promise<{ size: number; sha256: string }>;
  readonly remove: (uri: string) => Promise<void>;
  readonly move: (source: string, destination: string) => Promise<void>;
  readonly upload: (
    uri: string,
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) => Promise<void>;
}
function imageType(bytes: Uint8Array) {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  const text = String.fromCharCode(...bytes);
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  throw new Error("Choose an unchanged PNG, JPEG, GIF or WebP original");
}
export class MobileSpaceOriginalFiles {
  readonly #leases = new Map<0 | 1, { token: string; count: number }>();
  readonly #cleaning = new Set<0 | 1>();
  #importing = false;
  constructor(
    readonly io: SpaceOriginalFileIO,
    readonly inventory: SpaceImageStore<NativeSpaceOriginal>["load"],
    readonly newToken: () => string,
  ) {}
  hold(original: NativeSpaceOriginal) {
    const value = nativeSpaceOriginalCodec(original);
    const held = this.#leases.get(value.fileSlot);
    if (this.#cleaning.has(value.fileSlot) || (held && held.token !== value.token))
      throw new Error("Spaces original slot is still owned by another task");
    const entry = held ?? { token: value.token, count: 0 };
    entry.count++;
    this.#leases.set(value.fileSlot, entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.count === 0) this.#leases.delete(value.fileSlot);
    };
  }
  async verify(original: NativeSpaceOriginal) {
    const release = this.hold(original);
    try {
      const actual = await this.io.inspect(this.io.uri(original.fileSlot, false), original.size);
      if (actual.size !== original.size || actual.sha256 !== original.sha256)
        throw new Error("Spaces original is missing or changed; its exact intent is retained");
    } finally {
      release();
    }
  }
  async cleanup(slot: 0 | 1) {
    if (this.#leases.has(slot) || this.#cleaning.has(slot)) return false;
    this.#cleaning.add(slot);
    try {
      const records = await this.inventory();
      if (records.some((record) => record.original.fileSlot === slot)) return false;
      await this.io.remove(this.io.uri(slot, true));
      await this.io.remove(this.io.uri(slot, false));
      return true;
    } finally {
      this.#cleaning.delete(slot);
    }
  }
  async retain(
    uri: string,
    maxBytes: number,
    publish: (original: NativeSpaceOriginal) => Promise<unknown>,
  ) {
    if (this.#importing) throw new Error("Finish the current Spaces file import first");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 10 * 1024 * 1024)
      throw new Error("Image import policy is unavailable");
    this.#importing = true;
    let slot: 0 | 1 | undefined;
    let release: (() => void) | undefined;
    try {
      const records = await this.inventory();
      if (
        records.length >= 2 ||
        records.reduce((n, r) => n + r.original.size, 0) + maxBytes > 75 * 1024 * 1024
      )
        throw new Error("Resolve a retained original before importing another image");
      slot = ([0, 1] as const).find(
        (value) =>
          !records.some((r) => r.original.fileSlot === value) &&
          !this.#leases.has(value) &&
          !this.#cleaning.has(value),
      );
      if (slot === undefined || !(await this.cleanup(slot)))
        throw new Error("Wait for original file cleanup before importing");
      const token = this.newToken();
      release = this.hold({
        version: 1,
        kind: "spaces-file",
        fileSlot: slot,
        token,
        size: 1,
        type: "image/png",
        sha256: "0".repeat(64),
      });
      const reader = await this.io.reader(uri);
      let size = 0;
      let header = new Uint8Array();
      try {
        const writer = await this.io.writer(this.io.uri(slot, true));
        try {
          for (;;) {
            const chunk = await reader.read(Math.min(65536, maxBytes - size + 1));
            if (!chunk.byteLength) break;
            size += chunk.byteLength;
            if (size > maxBytes) throw new Error("Image original exceeds the current byte limit");
            if (header.byteLength < 32) {
              const prefix = new Uint8Array(Math.min(32, header.byteLength + chunk.byteLength));
              prefix.set(header);
              prefix.set(
                chunk.subarray(0, prefix.byteLength - header.byteLength),
                header.byteLength,
              );
              header = prefix;
            }
            await writer.write(chunk);
          }
        } finally {
          writer.close();
        }
      } finally {
        reader.close();
      }
      if (!size) throw new Error("The selected image original is empty");
      const type = imageType(header);
      const actual = await this.io.inspect(this.io.uri(slot, true), maxBytes);
      if (actual.size !== size) throw new Error("Image copy size changed; no intent was published");
      const original = nativeSpaceOriginalCodec({
        version: 1,
        kind: "spaces-file",
        fileSlot: slot,
        token,
        size,
        type,
        sha256: actual.sha256,
      });
      await this.io.move(this.io.uri(slot, true), this.io.uri(slot, false));
      await publish(original);
      return original;
    } finally {
      release?.();
      this.#importing = false;
      // Failed publication may have committed; only the healthy SQL inventory can prove absence.
      if (slot !== undefined) await this.cleanup(slot).catch(() => false);
    }
  }
  post(original: NativeSpaceOriginal, url: string, current: () => boolean) {
    const abort = new AbortController();
    const release = this.hold(original);
    const done = (async () => {
      try {
        await this.verify(original);
        if (abort.signal.aborted || !current()) throw new Error("Upload source connection changed");
        await this.io.upload(
          this.io.uri(original.fileSlot, false),
          url,
          { "Content-Type": original.type, "Content-Length": String(original.size) },
          abort.signal,
        );
      } finally {
        release();
      }
    })();
    return { done, abort: () => abort.abort() };
  }
}

export function withNativeSpaceOriginals(
  store: SpaceImageStore<NativeSpaceOriginal>,
  files: MobileSpaceOriginalFiles,
): SpaceImageStore<NativeSpaceOriginal> {
  return {
    load: async () => {
      const records = await store.load();
      for (const record of records) await files.verify(record.original);
      return records;
    },
    put: async (record, expected) => {
      const release = files.hold(record.original);
      try {
        await files.verify(record.original);
        await store.put(record, expected);
      } finally {
        release();
      }
    },
    remove: async (record) => {
      const release = files.hold(record.original);
      try {
        await files.verify(record.original);
        await store.remove(record);
      } finally {
        release();
      }
      await files.cleanup(record.original.fileSlot).catch(() => false);
    },
  };
}
