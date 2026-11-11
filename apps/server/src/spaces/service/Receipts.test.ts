import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t2code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as C from "@t2code/contracts/spaces";
import * as Schema from "effect/Schema";
import * as Receipts from "../Receipts.ts";
import * as SpacesService from "../SpacesService.ts";
import * as SpacesSql from "../SpacesSql.ts";
import {
  environmentId,
  env,
  block,
  parseJson,
  bytes,
  fixture,
  boot,
  structureState,
  rootPage,
  recoveryIntent,
} from "./Spaces.testkit.ts";

const decodeRequest = Schema.decodeUnknownSync(C.SpaceMutationRequest);
const decodeReceipt = Schema.decodeUnknownSync(C.SpaceMutationReceipt);

it.layer(NodeServices.layer)("Spaces core service", (it) => {
  it.effect(
    "serializes first acquisition and commits a single guarded winner with a durable conflict",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const libraries = yield* Effect.all([service.listSpaces(env), service.listSpaces(env)], {
            concurrency: "unbounded",
          });
          assert.deepEqual(libraries[0], libraries[1]);
          const { request, page } = yield* boot();
          const a = request("a", 0, [{ kind: "insert", block: block("a") }], 3);
          const b = request("b", 0, [{ kind: "insert", block: block("b") }], 4);
          const outcomes = yield* Effect.all(
            [service.applyBlockBatch(a), service.applyBlockBatch(b)],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["conflict", "saved"]);
          const loser = outcomes[0].status === "conflict" ? a : b;
          const conflict = outcomes.find((outcome) => outcome.status === "conflict")!;
          assert.equal(conflict.revision, 1);
          if (conflict.status === "conflict") assert.equal(conflict.current.pages[0]?.revision, 1);
          const window = yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 });
          assert.equal(window.blocks.length, 1);
          const found = yield* service.lookupMutationReceipt({
            request: { operation: "applyBlockBatch", input: loser },
          });
          assert.deepEqual(found, {
            status: "found",
            receipt: { operation: "applyBlockBatch", result: conflict },
          });
          assert.deepEqual(yield* service.applyBlockBatch(loser), conflict);
        }),
      ),
  );

  it.effect(
    "replays exact receipts after revisions and expiry, rejects mismatched intent and never executes an expired absence",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, common, page } = yield* boot();
          const first = request("save", 0, [{ kind: "insert", block: block("a") }], 7);
          const saved = yield* service.applyBlockBatch(first);
          yield* service.updatePage({
            ...common,
            pageId: page.id,
            mutationId: "rename",
            baseRevision: 1,
            title: "New",
          });
          const missing = { ...first, mutationId: "never-submitted" };
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: missing },
            }),
            { status: "absent" },
          );
          for (const changed of [
            { ...first, generation: 8 },
            { ...first, receiptEpoch: "other" },
            { ...first, mutations: [{ kind: "insert", block: { ...block("a"), opaque: 1 } }] },
          ]) {
            assert.equal(
              (yield* Effect.flip(service.applyBlockBatch(changed)))._tag,
              "SpaceMutationIdMismatchError",
            );
          }
          assert.equal(
            (yield* Effect.flip(
              service.createSpace({ ...common, mutationId: "save", title: "different operation" }),
            ))._tag,
            "SpaceMutationIdMismatchError",
          );
          yield* TestClock.adjust("2 days");
          assert.deepEqual(yield* service.applyBlockBatch(first), saved);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: missing },
            }),
            { status: "unknown" },
          );
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(missing)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* TestClock.setTime(0);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(missing)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* TestClock.adjust("10 days");
          // Known receipts replay even past retention until a bounded issuance pass actually removes them.
          assert.deepEqual(yield* service.applyBlockBatch(first), saved);
          const current = yield* service.listSpaces(env);
          assert.notEqual(current.mutationAdmission.epoch, first.receiptEpoch);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: first },
            }),
            { status: "unknown" },
          );
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(first)))._tag,
            "SpaceMutationAdmissionError",
          );
          assert.equal((yield* service.getPage({ ...env, pageId: page.id })).page.revision, 2);
        }),
      ),
  );

  it.effect(
    "rejects excess properties on original raw requests and the fixed raw ceiling before stripping or fingerprinting",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request } = yield* boot();
          const valid = request("strict", 0, [{ kind: "insert", block: block("a") }]);
          for (const raw of [
            { ...valid, extra: true },
            { ...valid, mutations: [{ ...valid.mutations[0], extra: true }] },
          ]) {
            assert.equal(
              (yield* Effect.flip(service.applyBlockBatch(raw)))._tag,
              "SpaceValidationError",
            );
          }
          const huge = { ...valid, extra: "x".repeat(1_048_576) };
          const error = yield* Effect.flip(service.applyBlockBatch(huge));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.maximum, 1_048_576);
          const lookup = { request: { operation: "applyBlockBatch", input: valid }, extra: true };
          assert.equal(
            (yield* Effect.flip(service.lookupMutationReceipt(lookup)))._tag,
            "SpaceValidationError",
          );
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "applyBlockBatch", input: valid },
            }),
            { status: "absent" },
          );
        }),
      ),
  );

  it.effect(
    "bounds raw decoding before the current policy and accounts for JSON escaping in IDs",
    () =>
      fixture(() =>
        Effect.gen(function* () {
          const { service, request, common, page } = yield* boot();
          const base = { ...common, mutationId: "protocol", title: "" };
          const room = 1_048_576 - bytes({ operation: "createSpace", input: base });
          const exact = { ...base, title: "x".repeat(room) };
          const error = yield* Effect.flip(service.createSpace(exact));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.maximum, 262_144);
          const over = yield* Effect.flip(
            service.createSpace({ ...exact, title: exact.title + "x" }),
          );
          assert.equal(over._tag, "SpaceLimitExceededError");
          if (over._tag === "SpaceLimitExceededError") assert.equal(over.maximum, 1_048_576);
          const id = "界".repeat(42);
          assert.equal(bytes(id), 128);
          const allowed = { ...block(id), content: { runs: [{ text: '\n"', marks: [] }] } };
          yield* service.applyBlockBatch(
            request("id-exact", 0, [{ kind: "insert", block: allowed }]),
          );
          const rejected = request("id-over", 1, [{ kind: "insert", block: block(id + "x") }]);
          assert.equal(
            (yield* Effect.flip(service.applyBlockBatch(rejected)))._tag,
            "SpaceLimitExceededError",
          );
          assert.deepEqual(
            (yield* service.readBlocks({ ...env, pageId: page.id, revision: 1 })).blocks,
            [allowed],
          );
        }),
      ),
  );

  it.effect(
    "commits identical concurrent intent once and accounts for persisted receipts independently",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const { service, common, library } = yield* boot();
          const input = { ...common, mutationId: "same", title: "界" };
          const results = yield* Effect.all(
            [service.createSpace(input), service.createSpace(input)],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(results[0], results[1]);
          assert.equal((yield* service.listSpaces(env)).items.length, 2);
          const noOp = yield* service.setDefaultSpace({
            ...common,
            mutationId: "no-op",
            spaceId: library.defaultSpaceId,
            defaultSpaceId: library.defaultSpaceId,
            baseRevision: 0,
            baseDefaultRevision: 0,
          });
          assert.equal(noOp.status, "saved");
          assert.equal((yield* service.listSpaces(env)).catalogRevision, 2);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [meta] = yield* sql<{
              readonly receipt_rows: number;
              readonly receipt_bytes: number;
            }>`SELECT receipt_rows, receipt_bytes FROM spaces_core`;
            const rows = yield* sql<{
              readonly mutation_id: string;
              readonly fingerprint: string;
              readonly payload: string;
              readonly epoch: string;
              readonly logical_bytes: number;
              readonly retain_until: number;
            }>`SELECT * FROM spaces_receipts`;
            assert.equal(meta?.receipt_rows, 3);
            const logical = rows.map((row) => ({
              environmentId,
              mutationId: row.mutation_id,
              receiptEpoch: row.epoch,
              fingerprint: row.fingerprint,
              createdAt: "1970-01-01T00:00:00.000Z",
              retainUntil: "1970-01-09T00:00:00.000Z",
              receipt: parseJson(row.payload),
            }));
            assert.deepEqual(
              rows.map((row) => row.logical_bytes),
              logical.map(bytes),
            );
            assert.equal(
              meta?.receipt_bytes,
              logical.reduce((total, row) => total + bytes(row), 0),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
        }),
      ),
  );
  it.effect(
    "refuses new work at receipt quota without evicting unexpired receipts and cleans only a bounded expired batch",
    () =>
      fixture((dbPath) =>
        Effect.gen(function* () {
          const service = yield* SpacesService.SpacesService;
          const library = yield* service.listSpaces(env);
          const common = { ...env, receiptEpoch: library.mutationAdmission.epoch };
          const parent = yield* rootPage(service, common, library.defaultSpaceId, "quota-parent");
          const recoveryTarget = yield* rootPage(
            service,
            common,
            library.defaultSpaceId,
            "quota-trash-target",
          );
          yield* service.trashPage(
            yield* recoveryIntent(
              service,
              common,
              recoveryTarget.id,
              "trash",
              "quota-trash-initial",
            ),
          );
          yield* Effect.flip(service.search({ ...env, query: "quota-search" }));
          yield* service.search({ ...env, query: "quota-search" });
          const input = {
            ...common,
            mutationId: "receipt-00000",
            spaceId: library.defaultSpaceId,
            baseRevision: 0,
            title: library.items[0]!.title,
          };
          const first = yield* service.renameSpace(input);
          // Fill to the quota in one transaction: serving 50,000 mutations one by one would be slow.
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [meta] =
              yield* sql<Receipts.Metadata>`SELECT * FROM spaces_core WHERE singleton = 1`;
            const [epoch] = yield* sql<{
              readonly retain_until: number;
            }>`SELECT retain_until FROM spaces_epochs WHERE epoch = ${common.receiptEpoch}`;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                for (let i = 1; i < 49_997; i++) {
                  const mutationId = `receipt-${String(i).padStart(5, "0")}`;
                  yield* Receipts.store(
                    decodeRequest({ operation: "renameSpace", input: { ...input, mutationId } }),
                    decodeReceipt({
                      operation: "renameSpace",
                      result: { ...first, mutationId },
                    }),
                    { ...meta!, receipt_rows: 0, receipt_bytes: 0 },
                    epoch!.retain_until,
                  );
                }
              }).pipe(Effect.provideService(SpacesSql.SpacesSql, sql)),
            );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
          const rejected = { ...common, mutationId: "over-capacity", title: "Must roll back" };
          const error = yield* Effect.flip(service.createSpace(rejected));
          assert.equal(error._tag, "SpaceLimitExceededError");
          if (error._tag === "SpaceLimitExceededError") assert.equal(error.limit, "maxReceiptRows");
          const placement = { pageId: parent.id, parentId: null, beforeBlockId: null };
          const guarded = yield* service.inspectStructure({
            ...env,
            target: { kind: "blocks", pageId: parent.id, blockIds: [] },
            destination: { kind: "child", placement },
          });
          const snapshot = yield* structureState(dbPath);
          const childError = yield* Effect.flip(
            service.createChildPage({
              ...common,
              mutationId: "quota-child",
              title: "No",
              placement,
              guards: guarded.guards,
            }),
          );
          assert.equal(childError._tag, "SpaceLimitExceededError");
          if (childError._tag === "SpaceLimitExceededError")
            assert.equal(childError.limit, "maxReceiptRows");
          assert.deepEqual(yield* structureState(dbPath), snapshot);
          const rejectedSearchWrites = [
            service
              .updatePage({
                ...common,
                mutationId: "quota-search-title",
                pageId: parent.id,
                baseRevision: 0,
                title: "quotasearchneedle",
              })
              .pipe(Effect.asVoid),
            service
              .applyBlockBatch({
                ...common,
                mutationId: "quota-search-block",
                pageId: parent.id,
                baseRevision: 0,
                generation: 0,
                mutations: [
                  {
                    kind: "insert",
                    block: {
                      ...block("quota-search-block"),
                      content: { runs: [{ text: "quotasearchneedle", marks: [] }] },
                    },
                  },
                ],
              })
              .pipe(Effect.asVoid),
          ];
          for (const attempt of rejectedSearchWrites) {
            const error = yield* Effect.flip(attempt);
            assert.equal(error._tag, "SpaceLimitExceededError");
            if (error._tag === "SpaceLimitExceededError")
              assert.equal(error.limit, "maxReceiptRows");
            assert.deepEqual(yield* structureState(dbPath), snapshot);
            assert.deepEqual(
              (yield* service.search({ ...env, query: "quotasearchneedle" })).items,
              [],
            );
          }
          for (const operation of ["trash", "restore", "permanentlyDelete"] as const) {
            const target = operation === "trash" ? parent.id : recoveryTarget.id;
            const intent = yield* recoveryIntent(
              service,
              common,
              target,
              operation,
              `quota-recovery-${operation}`,
            );
            const attempt =
              operation === "trash"
                ? service.trashPage(intent).pipe(Effect.asVoid)
                : operation === "restore"
                  ? service.restorePage(intent).pipe(Effect.asVoid)
                  : service.permanentlyDeletePage(intent).pipe(Effect.asVoid);
            const error = yield* Effect.flip(attempt);
            assert.equal(error._tag, "SpaceLimitExceededError");
            if (error._tag === "SpaceLimitExceededError")
              assert.equal(error.limit, "maxReceiptRows");
            assert.deepEqual(yield* structureState(dbPath), snapshot);
          }
          assert.deepEqual(yield* service.renameSpace(input), first);
          assert.deepEqual(
            yield* service.lookupMutationReceipt({
              request: { operation: "createSpace", input: rejected },
            }),
            { status: "absent" },
          );
          const before = yield* service.listSpaces(env);
          assert.equal(before.items.length, 1);
          assert.equal(before.catalogRevision, 3);
          const inspect = Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const [row] = yield* sql<{
              readonly count: number;
              readonly actual: number;
            }>`SELECT receipt_rows AS count, (SELECT COUNT(*) FROM spaces_receipts) AS actual FROM spaces_core`;
            return row;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
          assert.deepEqual(yield* inspect, { count: 50_000, actual: 50_000 });
          yield* TestClock.adjust("8 days");
          const rotated = yield* service.listSpaces(env);
          assert.notEqual(rotated.mutationAdmission.epoch, common.receiptEpoch);
          assert.deepEqual(yield* inspect, { count: 49_900, actual: 49_900 });
          assert.deepEqual(
            yield* service.lookupMutationReceipt({ request: { operation: "renameSpace", input } }),
            { status: "unknown" },
          );
          const retained = { ...input, mutationId: "receipt-49996" };
          assert.equal((yield* service.renameSpace(retained)).status, "saved");
          assert.equal(
            (yield* Effect.flip(service.renameSpace(input)))._tag,
            "SpaceMutationAdmissionError",
          );
          yield* service.createSpace({
            ...rejected,
            receiptEpoch: rotated.mutationAdmission.epoch,
          });
          assert.deepEqual(yield* inspect, { count: 49_901, actual: 49_901 });
        }),
      ),
  );
});
