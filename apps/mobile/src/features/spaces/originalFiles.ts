import { spaceMediaKind, type SpaceImageStore } from "@t2code/client-runtime/spaces";
import {
  nativeSpaceMediaMaxBytes,
  nativeSpaceOriginalCodec,
  type NativeSpaceOriginal,
  type NativeSpaceMediaKind,
} from "./originals";
import { nativeSpaceOriginalMime } from "./originalSignature";

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
      const reader = await this.io.reader(this.io.uri(original.fileSlot, false));
      try {
        const header = new Uint8Array(Math.min(65536, original.size));
        let size = 0;
        while (size < header.byteLength) {
          const chunk = await reader.read(header.byteLength - size);
          if (!chunk.byteLength) break;
          if (chunk.byteLength > header.byteLength - size)
            throw new Error("Original header read exceeded its byte bound");
          header.set(chunk, size);
          size += chunk.byteLength;
        }
        if (nativeSpaceOriginalMime(header.subarray(0, size)) !== original.type)
          throw new Error(
            "Retained original signature does not match its MIME type; intent retained",
          );
      } finally {
        reader.close();
      }
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
    policy: { kind: NativeSpaceMediaKind; maxBytes: number; maxHeaderBytes: number },
    publish: (original: NativeSpaceOriginal) => Promise<unknown>,
  ) {
    if (this.#importing) throw new Error("Finish the current Spaces file import first");
    if (
      !Number.isSafeInteger(policy.maxBytes) ||
      policy.maxBytes < 1 ||
      policy.maxBytes > nativeSpaceMediaMaxBytes(policy.kind) ||
      !Number.isSafeInteger(policy.maxHeaderBytes) ||
      policy.maxHeaderBytes < 1 ||
      policy.maxHeaderBytes > 65536
    )
      throw new Error("Media import policy is unavailable");
    this.#importing = true;
    let slot: 0 | 1 | undefined;
    let release: (() => void) | undefined;
    try {
      const records = await this.inventory();
      const remaining = 75 * 1024 * 1024 - records.reduce((n, r) => n + r.original.size, 0);
      if (records.length >= 2 || remaining < 1)
        throw new Error("Resolve a retained original before importing another file");
      const maxBytes = Math.min(policy.maxBytes, remaining);
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
      const header = new Uint8Array(policy.maxHeaderBytes);
      let headerSize = 0;
      try {
        const writer = await this.io.writer(this.io.uri(slot, true));
        try {
          for (;;) {
            const requested = Math.min(65536, maxBytes - size + 1);
            const chunk = await reader.read(requested);
            if (!chunk.byteLength) break;
            if (chunk.byteLength > requested)
              throw new Error("Original read exceeded its byte bound");
            size += chunk.byteLength;
            if (size > maxBytes) throw new Error("Media original exceeds the current byte limit");
            const prefix = chunk.subarray(0, header.byteLength - headerSize);
            header.set(prefix, headerSize);
            headerSize += prefix.byteLength;
            await writer.write(chunk);
          }
        } finally {
          writer.close();
        }
      } finally {
        reader.close();
      }
      if (!size) throw new Error("The selected original is empty");
      const type = nativeSpaceOriginalMime(header.subarray(0, headerSize));
      if (spaceMediaKind(type) !== policy.kind)
        throw new Error("Selected media kind does not match its file signature");
      const actual = await this.io.inspect(this.io.uri(slot, true), maxBytes);
      if (actual.size !== size)
        throw new Error("Original copy size changed; no intent was published");
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
