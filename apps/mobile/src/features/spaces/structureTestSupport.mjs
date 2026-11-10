import { expect } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { SpaceBlockId } from "../../../../../packages/contracts/src/spaces.ts";
import {
  SpaceDocumentSession,
  createSpaceServiceSessionAdapter,
} from "../../../../../packages/client-runtime/src/spaces/index.ts";
import { createMobileSpaceStructure } from "../../features/spaces/structure.ts";
import { MobileSpaceDocuments } from "../../features/spaces/documents.ts";
import { SpacesPageReader } from "../../features/spaces/reader.ts";

export function client(context, db = context.db) {
  const { environmentId, service, run, capability } = context;
  const clientId = NodeCrypto.randomUUID();
  const control = {
    writable: true,
    connected: true,
    generation: 1,
    ids: 0,
    requests: [],
    receipts: [],
    afterStore: null,
    afterSend: null,
    afterContentSend: null,
    beforeDraftWrite: null,
    contentRequests: [],
    contentAdmissions: 0,
    contentReceipts: [],
    failReads: new Set(),
    refreshed: [],
    changed: 0,
    draftReads: [],
    maxRows: capability.limits.maxListRows,
    capability,
    failDeletionProof: false,
  };
  const access = (write) => {
    if (!control.connected || (write && !control.writable))
      throw new Error("Current read/operate permission unavailable");
  };
  const read = async (effect) => {
    access(false);
    const generation = control.generation;
    const result = await run(effect);
    access(false);
    if (generation !== control.generation) throw new Error("Connection changed during read");
    return result;
  };
  const send = async (request) => {
    access(true);
    expect((await db.structure.load(environmentId)).pending.request).toEqual(request);
    access(true);
    control.requests.push(structuredClone(request));
    const result = await run(service[request.operation](request.input));
    await control.afterSend?.(request, result);
    return result;
  };
  const accessSnapshot = () => {
    const generation = control.generation;
    return {
      availability: control.connected
        ? control.writable
          ? "writable"
          : "read-only"
        : "disconnected",
      capability: control.capability,
      current: () => control.connected && control.generation === generation,
    };
  };
  let owner;
  const documents = new MobileSpaceDocuments((target) => {
    const key = { environmentId, pageId: target.pageId };
    let reader;
    const session = new SpaceDocumentSession(key, {
      drafts: {
        load: db.store.load,
        write: async (draftKey, draft) => {
          await control.beforeDraftWrite?.(draftKey, draft);
          await db.store.write(draftKey, draft);
        },
      },
      maxLoadedBlocks: 100,
      maxMutations: 100,
      createMutationId: () => `${clientId}-content-${++control.ids}`,
      assertMutable: () => {
        access(true);
        owner.assertReady();
        documents.assertUnreserved(key);
        reader.assertContentReady();
      },
      adapter: createSpaceServiceSessionAdapter(key, {
        limits: () => capability.limits,
        getPage: (input) => {
          control.contentAdmissions++;
          return read(service.getPage(input));
        },
        applyBlockBatch: async (input) => {
          const stored = await db.store.load(key);
          expect(stored.pending).toMatchObject({
            mutationId: input.mutationId,
            receiptEpoch: input.receiptEpoch,
            baseRevision: input.baseRevision,
            generation: input.generation,
            mutations: input.mutations,
          });
          control.contentRequests.push(structuredClone(input));
          const result = await run(service.applyBlockBatch(input));
          await control.afterContentSend?.(input, result);
          return result;
        },
        lookupMutationReceipt: async (input) => {
          const result = await read(service.lookupMutationReceipt(input));
          control.contentReceipts.push(result.status);
          return result;
        },
      }),
    });
    reader = new SpacesPageReader(target, {
      session,
      get access() {
        return accessSnapshot();
      },
      beforeRead: () => owner.hydrate(),
      locate: async () => {
        control.refreshed.push(target.pageId);
        const metadata = await read(service.getPage(key));
        if (control.failReads.has(target.pageId))
          throw new Error("Actual document read could not be delivered");
        const source = control.generation;
        return {
          ...metadata,
          ancestors: [],
          current: () => (source === control.generation && control.connected ? metadata : null),
        };
      },
      blocks: (input) => read(service.readBlocks(input)),
      confirmDeleted: async () => {
        const result = await read(
          service.resolveReference({
            environmentId,
            target: { kind: "page", pageId: target.pageId },
          }),
        );
        if (control.failDeletionProof) throw new Error("Deletion proof delivery failed");
        return result.status === "deleted";
      },
    });
    return reader;
  });
  owner = createMobileSpaceStructure(environmentId, {
    documents,
    drafts: {
      load: (key) => {
        control.draftReads.push(key.pageId);
        return db.store.load(key);
      },
      write: db.store.write,
    },
    store: {
      load: db.structure.load,
      write: async (id, journal) => {
        await db.structure.write(id, journal);
        await control.afterStore?.(journal);
      },
    },
    newId: () => `${clientId}-structure-${++control.ids}`,
    assertAccess: access,
    libraryAccess: access,
    capability: () => control.capability,
    maxRows: () => control.maxRows,
    maxMutationBytes: () => capability.limits.maxMutationBytes,
    getPage: (pageId) => read(service.getPage({ environmentId, pageId })),
    spaces: (input) => read(service.listSpaces(input)),
    list: (input) => read(service.listPages(input)),
    blocks: (input) => read(service.readBlocks(input)),
    inspect: (input) => read(service.inspectStructure(input)),
    receipt: async (input) => {
      const result = await read(service.lookupMutationReceipt(input));
      control.receipts.push(result.status);
      return result;
    },
    library: async (request) => ({ operation: request.operation, result: await send(request) }),
    createChild: (input) => send({ operation: "createChildPage", input }),
    move: (input) => send({ operation: "movePage", input }),
    recovery: (operation, input) => send({ operation, input }),
    trashList: (input) => read(service.listTrash(input)),
    moveBlocks: (input) => send({ operation: "moveBlocks", input }),
    purge: (input) => send({ operation: "permanentlyDeletePage", input }),
    changed: () => {
      control.changed++;
    },
  });
  return { owner, documents, control, access: accessSnapshot };
}

export async function defaultSpace(context) {
  const catalog = await context.run(
    context.service.listSpaces({ environmentId: context.environmentId }),
  );
  return (
    await context.run(
      context.service.listPages({
        environmentId: context.environmentId,
        spaceId: catalog.defaultSpaceId,
        limit: 1,
      }),
    )
  ).space;
}

export async function root(context, runtime, space, title) {
  const admission = await context.run(
    context.service.listPages({
      environmentId: context.environmentId,
      spaceId: space.id,
      limit: 1,
    }),
  );
  await runtime.owner.createRootPage(admission.space, title);
  return runtime.owner.getSnapshot().libraryResult.page;
}

export function paragraph(id) {
  return {
    id: SpaceBlockId.make(id),
    type: "paragraph",
    version: 1,
    parentId: null,
    order: "80000000000000000000000000000000",
    content: { runs: [{ text: "Saved content", marks: [] }] },
  };
}

export async function pageMetadata(context, pageId) {
  return context.run(context.service.getPage({ environmentId: context.environmentId, pageId }));
}

export async function trashedPage(context, pageId) {
  const inspection = await context.run(
    context.service.inspectStructure({
      environmentId: context.environmentId,
      target: { kind: "page", pageId },
      recovery: "restore",
    }),
  );
  return inspection.pages.find((page) => page.id === pageId);
}

export async function pageWindow(context, pageId) {
  const metadata = await pageMetadata(context, pageId);
  return context.run(
    context.service.readBlocks({
      environmentId: context.environmentId,
      pageId,
      revision: metadata.page.revision,
    }),
  );
}

export async function child(context, runtime, parent, title) {
  await runtime.owner.loadBody(parent.id);
  await runtime.owner.createChild(title, {
    pageId: parent.id,
    parentId: null,
    beforeBlockId: null,
  });
  return (await pageMetadata(context, runtime.owner.getSnapshot().journal.history.pageId)).page;
}

export async function prepareMove(context, runtime, pageId, destination) {
  const metadata = await pageMetadata(context, pageId);
  await runtime.owner.loadSource(pageId);
  if (metadata.page.location.kind === "root")
    await runtime.owner.browse(metadata.page.spaceId, pageId);
  if (destination.kind === "root") await runtime.owner.browse(destination.spaceId, pageId);
  else await runtime.owner.loadBody(destination.placement.pageId);
}

export async function recoverPage(runtime, pageId, operation, confirmPermanentDeletion = false) {
  await runtime.owner.previewRecovery(pageId, operation);
  const preview = runtime.owner.getSnapshot().recoveryPreview;
  await runtime.owner.confirmRecovery(preview, confirmPermanentDeletion);
  return preview;
}

export async function seedBlocks(context, page, blocks) {
  const metadata = await pageMetadata(context, page.id);
  const result = await context.run(
    context.service.applyBlockBatch({
      environmentId: context.environmentId,
      pageId: page.id,
      baseRevision: metadata.page.revision,
      receiptEpoch: metadata.mutationAdmission.epoch,
      mutationId: NodeCrypto.randomUUID(),
      generation: 1,
      mutations: blocks.map((block) => ({ kind: "insert", block })),
    }),
  );
  expect(result.status).toBe("saved");
}

export async function externalRecovery(context, pageId, operation) {
  const inspection = await context.run(
    context.service.inspectStructure({
      environmentId: context.environmentId,
      target: { kind: "page", pageId },
      recovery: operation,
    }),
  );
  const admission = await context.run(
    context.service.listSpaces({ environmentId: context.environmentId, limit: 1 }),
  );
  return context.run(
    context.service[operation === "trash" ? "trashPage" : "restorePage"]({
      environmentId: context.environmentId,
      pageId,
      guards: inspection.guards,
      receiptEpoch: admission.mutationAdmission.epoch,
      mutationId: NodeCrypto.randomUUID(),
    }),
  );
}

export function legacyOpaque(context, pageId, block) {
  const sql = new NodeSqlite.DatabaseSync(
    NodePath.join(NodePath.dirname(context.fixture.file), "spaces.sqlite"),
  );
  try {
    const previous = sql
      .prepare("SELECT logical_bytes FROM spaces_blocks WHERE block_id = ?")
      .get(block.id);
    const payload = JSON.stringify(block);
    const bytes = new TextEncoder().encode(payload).byteLength;
    sql.exec("BEGIN");
    sql
      .prepare("UPDATE spaces_blocks SET payload = ?, logical_bytes = ? WHERE block_id = ?")
      .run(payload, bytes, block.id);
    sql
      .prepare("UPDATE spaces_pages SET block_bytes = block_bytes + ? WHERE page_id = ?")
      .run(bytes - previous.logical_bytes, pageId);
    sql.exec("COMMIT");
  } finally {
    if (sql.isTransaction) sql.exec("ROLLBACK");
    sql.close();
  }
}

export async function seedBlock(context, page, block) {
  const metadata = await context.run(
    context.service.getPage({ environmentId: context.environmentId, pageId: page.id }),
  );
  await context.run(
    context.service.applyBlockBatch({
      environmentId: context.environmentId,
      pageId: page.id,
      baseRevision: metadata.page.revision,
      receiptEpoch: metadata.mutationAdmission.epoch,
      mutationId: `seed-${block.id}`,
      generation: 1,
      mutations: [{ kind: "insert", block }],
    }),
  );
}
