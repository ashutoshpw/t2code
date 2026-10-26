import { describe, expect, it } from "@effect/vitest";
import {
  SpaceBlockId,
  SpaceId,
  SpacePageId,
  SpaceReceiptEpoch,
  type SpacePageGetResult,
} from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import { readSpacePageLocation } from "./pageLocation.ts";

const spaceId = SpaceId.make("current-space");
const timestamp = "2026-10-26T00:00:00Z";
function metadata(id: string, parent: string | null = null): SpacePageGetResult {
  return {
    page: {
      id: SpacePageId.make(id),
      spaceId,
      title: id,
      revision: 1,
      rootOrder: parent ? null : "rank",
      location: parent
        ? {
            kind: "child",
            spaceId,
            ownerBlockId: SpaceBlockId.make(`owner-${id}`),
            parentPageId: SpacePageId.make(parent),
          }
        : { kind: "root", spaceId, order: "rank" },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    space: {
      id: spaceId,
      title: "Current space",
      revision: 1,
      rootOrderRevision: 1,
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    mutationAdmission: {
      epoch: SpaceReceiptEpoch.make("epoch"),
      acceptsUntil: timestamp,
      retainUntil: timestamp,
    },
  };
}

describe("readSpacePageLocation", () => {
  it.effect(
    "resolves the current normalized ancestry and verifies its revisions before publishing hints",
    () =>
      Effect.gen(function* () {
        const rows = [metadata("child", "parent"), metadata("parent", "root"), metadata("root")];
        const reads: string[] = [];
        const result = yield* readSpacePageLocation(
          { pageId: rows[0]!.page.id, version: 2 },
          (id) => {
            reads.push(id);
            return Effect.succeed(rows.find((row) => row.page.id === id)!);
          },
        );
        expect(result.page.spaceId).toBe("current-space");
        expect(result.ancestors.map((page) => page.id)).toEqual(["root", "parent"]);
        expect(reads).toEqual(["child", "parent", "root", "child", "root", "parent"]);
      }),
  );

  it.effect("does not fabricate a location for legacy v1 metadata or missing v2 location", () =>
    Effect.gen(function* () {
      const row = metadata("legacy");
      const { location: _location, ...legacy } = row.page;
      let reads = 0;
      const read = () => {
        reads++;
        return Effect.succeed({ ...row, page: legacy });
      };
      const result = yield* readSpacePageLocation({ pageId: legacy.id, version: 1 }, read);
      expect(result.page).not.toHaveProperty("location");
      expect(result.ancestors).toEqual([]);
      expect(reads).toBe(1);
      const failure = yield* readSpacePageLocation({ pageId: legacy.id, version: 2 }, read).pipe(
        Effect.flip,
      );
      expect(failure.message).toContain("unavailable");
    }),
  );

  it.effect(
    "refuses a moved page during verification rather than rendering an obsolete parent path",
    () =>
      Effect.gen(function* () {
        const child = metadata("child", "parent");
        let reads = 0;
        const moved = metadata("child", "new-parent");
        const failure = yield* readSpacePageLocation(
          { pageId: child.page.id, version: 2 },
          (id) => {
            reads++;
            return Effect.succeed(
              id === child.page.id
                ? reads === 1
                  ? child
                  : { ...moved, page: { ...moved.page, revision: 2 } }
                : metadata("parent"),
            );
          },
        ).pipe(Effect.flip);
        expect(failure.message).toContain("location changed");
        expect(reads).toBe(3);
      }),
  );

  it.effect("bounds ancestry reads and UTF8 response bytes", () =>
    Effect.gen(function* () {
      const ids: string[] = [];
      const depthError = yield* readSpacePageLocation(
        { pageId: SpacePageId.make("0"), version: 2 },
        (id) => {
          ids.push(id);
          return Effect.succeed(metadata(id, String(Number(id) + 1)));
        },
      ).pipe(Effect.flip);
      expect(depthError.message).toContain("ancestry exceeds");
      expect(ids).toHaveLength(16);
      const row = metadata("big");
      const title = "界".repeat(Math.floor((2 * 1024 * 1024) / 3) + 1);
      const bytesError = yield* readSpacePageLocation({ pageId: row.page.id, version: 2 }, () =>
        Effect.succeed({ ...row, page: { ...row.page, title } }),
      ).pipe(Effect.flip);
      expect(bytesError.message).toContain("limit");
    }),
  );
});
