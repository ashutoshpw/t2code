import { requireNativeModule } from "expo";
import {
  type ComposerContextClipboardFragment,
  type ComposerContextRecord,
  type SpaceContextSelector,
  ComposerContextId,
  SPACE_CONTEXT_LIMITS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  COMPOSER_CONTEXT_MAX_RECORDS,
  type EnvironmentId,
} from "@t2code/contracts";
import {
  decodeComposerContextClipboardHtml,
  decodeComposerContextFragment,
  encodeComposerContextFragment,
} from "@t2code/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
  threadContextsOutsideEnvironment,
} from "@t2code/shared/composerContextReferences";
import { executeAtomQuery, squashAtomCommandFailure } from "@t2code/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t2code/client-runtime/state/assets";
import * as Option from "effect/Option";
import { appAtomRegistry } from "../state/atom-registry";
import { assetEnvironment } from "../state/assets";
import { environmentSession } from "../state/session";
import { downloadAttachmentForPreview } from "./attachmentDownload";
import {
  persistComposerAttachmentFile,
  removePersistedComposerAttachmentFile,
  type DraftComposerAttachment,
} from "./composerImages";
import { referencedComposerContext, reidentifyComposerContext } from "./composerContext";
import { uuidv4 } from "./uuid";
import {
  findLocalComposerClipboardAttachment,
  waitForComposerDraftsLoaded,
} from "../state/use-composer-drafts";
import { loadLocalAttachmentPreview } from "./localAttachmentPreview";

export interface NativeContextClipboard {
  readonly text: string;
  readonly fragment: string;
  readonly html: string;
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Context import cancelled");
}

const nativeClipboard = () =>
  requireNativeModule<{
    writeContextClipboard: (text: string, fragment: string) => Promise<void>;
  }>("T2ComposerEditor");

export function writeComposerContextClipboard(
  text: string,
  fragment: ComposerContextClipboardFragment,
): Promise<void> {
  const encoded = encodeComposerContextFragment(fragment);
  if (!encoded)
    return Promise.reject(
      new Error("This context selection is too large to copy. Select fewer items."),
    );
  return nativeClipboard().writeContextClipboard(text, encoded);
}

export async function importComposerContextClipboard(
  input: NativeContextClipboard,
  existingCount: number,
  signal: AbortSignal,
  existingContextCount = 0,
  destinationEnvironmentId?: EnvironmentId,
  /** The machines the destination links to, whose threads its agent can read too. */
  linkedEnvironments: ReadonlyMap<EnvironmentId, string> = new Map(),
) {
  const primary = decodeComposerContextFragment(input.fragment);
  const fragment = primary ?? decodeComposerContextClipboardHtml(input.html);
  const references = collectComposerContextReferences(input.text);
  const spaceReferences = references.filter((ref) => ref.kind === "page" || ref.kind === "block");
  if (!fragment) {
    if (spaceReferences.length)
      throw new Error("Spaces context cannot be hydrated. Copy the reference again.");
    return null;
  }
  if (input.text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
    throw new Error("Context text is too large to paste.");
  const selectors = fragment.selectors ?? [];
  if (
    new TextEncoder().encode(JSON.stringify(selectors)).byteLength >
    SPACE_CONTEXT_LIMITS.maxEnvelopeBytes
  )
    throw new Error("Selector context is too large to paste.");
  // Inspect raw identities before forward-compatible decoding can omit an unsupported record.
  const rawText = primary
    ? input.fragment
    : decodeURIComponent(/data-t2-context-fragment=["']([^"']+)["']/.exec(input.html)?.[1] ?? "");
  const raw: { records: readonly unknown[]; selectors?: readonly Record<string, unknown>[] } =
    JSON.parse(rawText);
  const rawEntries = [...raw.records, ...(raw.selectors ?? [])];
  const rawIds = rawEntries.flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    "contextId" in entry &&
    typeof entry.contextId === "string"
      ? [entry.contextId]
      : [],
  );
  if (new Set(rawIds).size !== rawIds.length)
    throw new Error("Context contains duplicate or ambiguous identities.");
  for (const selector of raw.selectors ?? []) {
    const keys = new Set([
      "version",
      "selection",
      "kind",
      "contextId",
      "label",
      "environmentId",
      "includeChildPages",
      selector.kind === "page" ? "pageId" : "blockId",
    ]);
    if (Object.keys(selector).some((key) => !keys.has(key)))
      throw new Error("This selector shape is not supported. Copy its completed context instead.");
  }
  const entries = [...fragment.records, ...selectors];
  for (const ref of spaceReferences) {
    if (
      entries.filter((entry) => entry.contextId === ref.contextId && entry.kind === ref.kind)
        .length !== 1
    )
      throw new Error("A Spaces reference is missing its context or selector.");
  }
  const selected = referencedComposerContext(input.text, { version: 1, records: fragment.records });
  const imported = reidentifyComposerContext(input.text, selected?.records ?? [], uuidv4);
  const selectedSelectors = selectors.filter((selector) =>
    references.some((ref) => ref.contextId === selector.contextId && ref.kind === selector.kind),
  );
  const importedSelectors: SpaceContextSelector[] = selectedSelectors.map((selector) => ({
    ...selector,
    contextId: ComposerContextId.make(uuidv4()),
  }));
  const selectorIds = new Map(
    selectedSelectors.map((selector, index) => [
      selector.contextId,
      importedSelectors[index]!.contextId,
    ]),
  );
  const text = replaceComposerContextReferences(imported.text, (ref) =>
    formatComposerContextReference({
      ...ref,
      contextId: selectorIds.get(ref.contextId) ?? ref.contextId,
    }),
  );
  const skippedThreads =
    destinationEnvironmentId === undefined
      ? []
      : threadContextsOutsideEnvironment({
          text: imported.text,
          records: imported.context.records,
          environmentId: destinationEnvironmentId,
          linkedEnvironments,
        });
  const skippedIds = new Set(skippedThreads.map((record) => record.contextId));
  const retained = imported.context.records.filter((record) => !skippedIds.has(record.contextId));
  if (
    existingContextCount + retained.length + importedSelectors.length >
    COMPOSER_CONTEXT_MAX_RECORDS
  )
    throw new Error("Remove some context items from the draft before pasting more.");
  const attachments: DraftComposerAttachment[] = [];
  const records: ComposerContextRecord[] = [];
  const failures: string[] = [];
  try {
    for (const record of retained) {
      checkAborted(signal);
      if (!("attachmentId" in record)) {
        records.push(record);
        continue;
      }
      try {
        if (existingCount + attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
          throw new Error("Attachment limit reached");
        const file = await importAttachment(record, fragment.source.environmentId, signal);
        attachments.push(file);
        records.push({ ...record, attachmentId: file.id });
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(record.name);
      }
    }
    // The last copy can be cancelled after its own check; a cancelled import must not return files nobody will release.
    checkAborted(signal);
    return {
      text,
      context: { version: 1 as const, records },
      ...(importedSelectors.length
        ? { contextDraft: { selectors: importedSelectors, records: [] } }
        : {}),
      attachments,
      failures,
      skippedThreads: skippedThreads.map((record) => record.title),
    };
  } catch (error) {
    await Promise.all(
      attachments.map((attachment) =>
        attachment.fileUri
          ? removePersistedComposerAttachmentFile(attachment.fileUri)
          : Promise.resolve(),
      ),
    );
    throw error;
  }
}

async function importAttachment(
  record: Extract<ComposerContextRecord, { attachmentId: string }>,
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<DraftComposerAttachment> {
  await waitForComposerDraftsLoaded();
  checkAborted(signal);
  const local = findLocalComposerClipboardAttachment(environmentId, record.attachmentId);
  if (local) {
    if (!local.fileUri && local.type === "image" && local.dataUrl)
      return {
        ...local,
        id: uuidv4(),
        uploadedAttachmentId: undefined,
        uploadEnvironmentId: undefined,
      };
    if (local.fileUri) {
      const preview = await loadLocalAttachmentPreview(
        { ...local, fileUri: local.fileUri },
        signal,
      );
      if (!preview) throw new Error("Context import cancelled");
      try {
        return await persistImportedAttachment(record, preview.uri, signal);
      } finally {
        preview.dispose();
      }
    }
  }
  const connection = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (Option.isNone(connection)) throw new Error("Reconnect to the source environment");
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: {
        resource: { _tag: "attachment", attachmentId: record.attachmentId, fileName: record.name },
      },
    }),
    { refresh: true, reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  checkAborted(signal);
  const url = resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl);
  if (!url) throw new Error("Attachment URL unavailable");
  const temporary = await downloadAttachmentForPreview({
    attachment: { name: record.name, mimeType: record.mimeType },
    url,
    signal,
  });
  if (!temporary) throw new Error("Attachment import cancelled");
  try {
    return await persistImportedAttachment(record, temporary.uri, signal);
  } finally {
    temporary.dispose();
  }
}

async function persistImportedAttachment(
  record: Extract<ComposerContextRecord, { attachmentId: string }>,
  uri: string,
  signal: AbortSignal,
): Promise<DraftComposerAttachment> {
  const fileUri = await persistComposerAttachmentFile(
    uri,
    record.name,
    record.kind === "image"
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  );
  if (signal.aborted) {
    await removePersistedComposerAttachmentFile(fileUri);
    checkAborted(signal);
  }
  const { File } = await import("expo-file-system");
  const common = {
    id: uuidv4(),
    fileUri,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: new File(fileUri).size,
  };
  return record.kind === "image"
    ? { ...common, type: "image", previewUri: fileUri }
    : { ...common, type: "file" };
}
