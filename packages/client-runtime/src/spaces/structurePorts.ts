import * as C from "@t2code/contracts/spaces";
import {
  type SpaceLibraryRequest,
  type SpaceLibraryReceipt,
  type SpaceStructureJournal,
  type Destination,
  type SpaceStructureStore,
} from "./structureJournal.ts";

export interface SpaceRootReorderPorts {
  readonly store: SpaceStructureStore;
  readonly spaces: (input: C.SpaceListInput) => Promise<C.SpaceListResult>;
  readonly blocks: (input: C.SpaceReadBlocksInput) => Promise<C.SpaceReadBlocksResult>;
  readonly list: (input: C.SpacePageListInput) => Promise<C.SpacePageListResult>;
  readonly inspect: (input: C.SpaceInspectStructureInput) => Promise<C.SpaceInspectStructureResult>;
  readonly getPage: (pageId: C.SpacePageId) => Promise<C.SpacePageGetResult>;
  readonly capability: () => Pick<C.SpaceCapability, "version" | "features" | "limits"> | undefined;
  readonly createChild: (
    input: C.SpaceCreateChildPageInput,
  ) => Promise<C.SpaceCreateChildPageResult>;
  readonly recovery: (
    operation: "trashPage" | "restorePage",
    input: C.SpacePageRecoveryInput,
  ) => Promise<C.SpacePageRecoveryResult>;
  readonly purge: (input: C.SpacePageRecoveryInput) => Promise<C.SpacePagePurgeResult>;
  readonly trashList: (input: C.SpaceTrashListInput) => Promise<C.SpaceTrashListResult>;
  readonly moveBlocks: (input: C.SpaceMoveBlocksInput) => Promise<C.SpaceMoveBlocksResult>;
  readonly move: (input: C.SpaceMovePageInput) => Promise<C.SpaceMovePageResult>;
  readonly receipt: (input: C.SpaceReceiptLookupInput) => Promise<C.SpaceReceiptLookupResult>;
  readonly newId: () => string;
  readonly assertAccess: (write: boolean) => void;
  readonly libraryAccess: (write: boolean) => void;
  readonly library: (request: SpaceLibraryRequest) => Promise<SpaceLibraryReceipt>;
  readonly maxMutationBytes: () => number;
  readonly maxRows: () => number;
  readonly reserve: (pages: readonly C.SpacePageId[], restoring: boolean) => () => void;
  readonly checkDrafts: (pages: readonly C.SpacePageId[]) => Promise<void>;
  readonly refresh: (pages: readonly C.SpacePageId[]) => Promise<void>;
  readonly changed: () => void;
}
export interface Position {
  readonly pageId: C.SpacePageId;
  readonly revision: number;
  readonly rootRevision: number;
  readonly beforePageId: C.SpacePageId | null;
  readonly location: C.SpacePageLocation;
  readonly destination: Destination;
  readonly guards: C.SpaceStructureGuards;
}
export interface SpaceBlockMoveProof {
  readonly sourcePageId: C.SpacePageId;
  readonly revision: number;
  readonly blockIds: readonly C.SpaceBlockId[];
  readonly selectedIds: readonly C.SpaceBlockId[];
  readonly inverse: C.SpaceBlockPlacement | null;
  readonly indent: C.SpaceBlockPlacement | null;
  readonly outdent: C.SpaceBlockPlacement | null;
}
export interface SpaceRecoveryPreview {
  readonly pageId: C.SpacePageId;
  readonly operation: C.SpaceRecoveryOperation;
  readonly inspection: C.SpaceInspectStructureResult;
  readonly placement: string;
}
export interface Snapshot {
  readonly libraryResult: {
    operation: SpaceLibraryRequest["operation"];
    space?: C.SpaceSummary;
    page?: C.SpacePageSummary;
  } | null;
  readonly trash: C.SpaceTrashListResult | null;
  readonly recoveryPreview: SpaceRecoveryPreview | null;
  readonly blockSelection: SpaceBlockMoveProof | null;
  readonly hydrated: boolean;
  readonly busy: boolean;
  readonly journal: SpaceStructureJournal;
  readonly window: C.SpacePageListResult | null;
  readonly position: Position | null;
  readonly spaces: C.SpaceListResult | null;
  readonly parentPageId: C.SpacePageId | null;
  readonly body: {
    pageId: C.SpacePageId;
    spaceId: C.SpaceId;
    revision: number;
    blocks: readonly C.SpaceBlock[];
    nextCursor: C.SpaceCursor | null;
  } | null;
  readonly error: unknown;
  readonly notice: string | null;
}
