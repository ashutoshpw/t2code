// @effect-diagnostics nodeBuiltinImport:off -- streaming directory handles and inode metadata bound discovery without loading flat directories.
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as C from "@t2code/contracts/spaces";
import { canonical } from "../CorePolicy.ts";

import { openMediaFile } from "../../assets/MediaFile.ts";
import * as SpacesSql from "../SpacesSql.ts";
import * as Reconciliation from "./Reconciliation.ts";
import { fileLimits, mediaTypes, type MediaType } from "./Policy.ts";

const attempt = /^[0-9a-f-]{36}\.part$/;
const digest = /^[0-9a-f]{64}$/;
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new C.SpacesUnavailableError({ stage: "storage" }) });
export const make = Effect.fn("SpacesInventory.make")(function* (directories: {
  readonly assetsDir: string;
  readonly stagingDir: string;
}) {
  const path = yield* Path.Path;
  const readers = new Map<string, NodeFS.Dir>();
  const generations = new Map<string, number>();
  const pending = new Map<
    string,
    {
      entries: Array<Effect.Success<ReturnType<typeof observe>>>;
      done: boolean;
      generation: number;
    }
  >();
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...readers.values()], (reader) =>
      Effect.promise(() => reader.close()).pipe(Effect.ignore),
    ),
  );
  const filename = (kind: string, name: string) => {
    if (name === "." || name === ".." || path.basename(name) !== name)
      throw new Error("Invalid inventory name");
    return path.join(kind === "assets" ? directories.assetsDir : directories.stagingDir, name);
  };
  const observe = Effect.fn("SpacesInventory.observe")(function* (
    kind: string,
    name: string,
    now: number,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const file = filename(kind, name);
        try {
          const info = await NodeFSP.lstat(file, { bigint: true });
          if (info.size > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error("Inventory size exceeds exact accounting");
          return {
            kind,
            name,
            bytes: info.isFile() ? Number(info.size) : 0,
            identity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
            regular: info.isFile(),
            modified: Number(info.mtimeMs),
            now,
          };
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return { kind, name, bytes: 0, identity: "missing", regular: true, modified: now, now };
          throw error;
        }
      },
      catch: () => new C.SpacesUnavailableError({ stage: "storage" }),
    });
  });
  const record = Effect.fn("SpacesInventory.record")(function* (
    entry: Effect.Success<ReturnType<typeof observe>>,
  ) {
    const sql = yield* SpacesSql.SpacesSql;
    const [old] = yield* sql<{
      readonly bytes: number;
      readonly identity: string;
      readonly first_seen_ms: number;
    }>`SELECT bytes,identity,first_seen_ms FROM spaces_asset_file_observations WHERE kind = ${entry.kind} AND name = ${entry.name}`;
    const firstSeen = old?.identity === entry.identity ? old.first_seen_ms : entry.now;
    yield* sql`INSERT INTO spaces_asset_file_observations(kind,name,bytes,identity,first_seen_ms,last_seen_ms)
      VALUES (${entry.kind},${entry.name},${entry.bytes},${entry.identity},${firstSeen},${entry.now})
      ON CONFLICT(kind,name) DO UPDATE SET bytes = excluded.bytes, identity = excluded.identity,
      first_seen_ms = excluded.first_seen_ms,last_seen_ms = excluded.last_seen_ms`;
    if (entry.kind === "assets")
      yield* sql`UPDATE spaces_asset_reconciliation SET assets_bytes = assets_bytes + ${entry.bytes - (old?.bytes ?? 0)},observed_at_ms = ${entry.now} WHERE singleton = 1`;
    else
      yield* sql`UPDATE spaces_asset_reconciliation SET staging_bytes = staging_bytes + ${entry.bytes - (old?.bytes ?? 0)},observed_at_ms = ${entry.now} WHERE singleton = 1`;
    const owned =
      entry.kind === "assets"
        ? digest.test(entry.name) &&
          (yield* sql`SELECT 1 FROM spaces_asset_blobs WHERE digest = ${entry.name} AND state <> 'deleted'`)
            .length > 0
        : attempt.test(entry.name) &&
          (yield* sql`SELECT 1 FROM spaces_asset_uploads WHERE attempt_id = ${entry.name.slice(0, -5)} AND state IN ('receiving','verified','ready')`)
            .length > 0;
    const reason =
      entry.identity === "missing"
        ? null
        : !entry.regular
          ? "nonfile"
          : owned
            ? null
            : entry.now - Math.max(firstSeen, entry.modified) >= 86_400_000
              ? "unknown_after_grace"
              : "unknown_within_grace";
    yield* Reconciliation.issue("file", canonical([entry.kind, entry.name]), reason);
  });
  const discover = Effect.fn("SpacesInventory.discover")(
    function* (kind: "assets" | "staging", now: number, generation: number) {
      const queued = pending.get(kind);
      if (queued) return queued;
      let reader = readers.get(kind);
      if (!reader) {
        const directory = kind === "assets" ? directories.assetsDir : directories.stagingDir;
        reader = yield* io(async () => {
          try {
            return await NodeFSP.opendir(directory);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return undefined;
            throw error;
          }
        });
        if (reader) {
          readers.set(kind, reader);
          generations.set(kind, generation);
        }
      }
      const observedGeneration = generations.get(kind) ?? generation;
      const entries: Array<Effect.Success<ReturnType<typeof observe>>> = [];
      let done = !reader;
      if (reader)
        for (let count = 0; count < 10; count++) {
          const entry = yield* io(() => reader!.read());
          if (!entry) {
            done = true;
            yield* io(() => reader!.close());
            readers.delete(kind);
            generations.delete(kind);
            break;
          }
          entries.push(yield* observe(kind, entry.name, now));
        }
      const batch = { entries, done, generation: observedGeneration };
      pending.set(kind, batch);
      return batch;
    },
    (effect, kind) =>
      effect.pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            const reader = readers.get(kind);
            readers.delete(kind);
            generations.delete(kind);
            pending.delete(kind);
            if (reader) yield* Effect.promise(() => reader.close()).pipe(Effect.ignore);
          }),
        ),
      ),
  );
  const refresh = Effect.fn("SpacesInventory.refresh")(function* (
    entries: readonly { readonly kind: string; readonly name: string }[],
    now: number,
  ) {
    return yield* Effect.forEach(entries, (entry) => observe(entry.kind, entry.name, now));
  });
  const verify = Effect.fn("SpacesInventory.verify")(function* (blob: {
    readonly digest: string;
    readonly byte_size: number;
    readonly mime_type: string;
    readonly media_kind: string;
  }) {
    const kind = Object.hasOwn(mediaTypes, blob.mime_type)
      ? mediaTypes[blob.mime_type as MediaType]
      : null;
    if (
      kind === null ||
      blob.media_kind !== kind ||
      !digest.test(blob.digest) ||
      blob.byte_size < 1 ||
      blob.byte_size > fileLimits[kind]
    )
      return false;
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* openMediaFile(filename("assets", blob.digest));
        if (!file || file.info.size !== BigInt(blob.byte_size)) return false;
        const hash = NodeCrypto.createHash("sha256");
        const buffer = new Uint8Array(Math.min(64 * 1024, blob.byte_size));
        let bytes = 0;
        // The enclosing scope owns the descriptor through the final integrity checks.
        while (bytes < blob.byte_size) {
          const chunk = yield* io(() =>
            file.handle.read(buffer, 0, Math.min(buffer.length, blob.byte_size - bytes), bytes),
          );
          if (chunk.bytesRead === 0) return false;
          hash.update(buffer.subarray(0, chunk.bytesRead));
          bytes += chunk.bytesRead;
        }
        const after = yield* io(() => file.handle.stat({ bigint: true }));
        const current = yield* openMediaFile(filename("assets", blob.digest), {
          device: file.info.dev.toString(),
          inode: file.info.ino.toString(),
        });
        return (
          current !== null &&
          bytes === blob.byte_size &&
          hash.digest("hex") === blob.digest &&
          after.size === file.info.size &&
          after.mtimeNs === file.info.mtimeNs &&
          current.info.mtimeNs === after.mtimeNs
        );
      }),
    ).pipe(Effect.orElseSucceed(() => false));
  });
  const acknowledge = (kind: string) =>
    Effect.sync(() => {
      pending.delete(kind);
    });
  return { record, discover, refresh, verify, acknowledge };
});
