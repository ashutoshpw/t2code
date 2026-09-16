import {
  PROJECT_FILE_UPLOAD_MAX_BYTES,
  type EnvironmentId,
} from "@t2code/contracts";
import { resolveAssetUrl } from "@t2code/client-runtime/state/assets";
import {
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t2code/client-runtime/state/runtime";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment } from "../state/projects";
import { readPreparedConnection } from "../state/session";
import { uploadBytes } from "./uploadBytes";

export interface WorkspaceFileUploadProgress {
  readonly files: number;
  readonly completedFiles: number;
  /** 0..1 across all files' bytes. */
  readonly fraction: number;
}

/**
 * Uploads dropped files into a workspace directory on the environment host.
 *
 * Mirrors the chat attachment cycle: the WS RPC only mints a signed URL, and
 * the bytes POST to the environment's HTTP base, so the same flow serves
 * local, remote, and tunnel connections alike.
 */
export async function uploadWorkspaceFiles(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly files: readonly File[];
  readonly onProgress: (progress: WorkspaceFileUploadProgress) => void;
  readonly onFileError: (fileName: string, reason: string) => void;
}): Promise<{ uploaded: number; failed: number }> {
  const files = [...input.files];
  if (files.length === 0) {
    return { uploaded: 0, failed: 0 };
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const loadedBytes = new Array<number>(files.length).fill(0);
  let completedFiles = 0;
  const emitProgress = () => {
    input.onProgress({
      files: files.length,
      completedFiles,
      fraction: totalBytes === 0 ? 1 : loadedBytes.reduce((sum, loaded) => sum + loaded, 0) / totalBytes,
    });
  };
  emitProgress();

  const uploadFile = async (file: File, index: number): Promise<boolean> => {
    const fail = (reason: string) => {
      completedFiles += 1;
      loadedBytes[index] = file.size;
      emitProgress();
      input.onFileError(file.name, reason);
      return false;
    };

    if (file.size === 0) {
      return fail("The file is empty");
    }
    if (file.size > PROJECT_FILE_UPLOAD_MAX_BYTES) {
      return fail(`'${file.name}' exceeds the ${Math.floor(PROJECT_FILE_UPLOAD_MAX_BYTES / (1024 * 1024))} MB upload limit`);
    }

    const minted = await runAtomCommand(
      appAtomRegistry,
      projectEnvironment.createFileUploadUrl,
      {
        environmentId: input.environmentId,
        input: { cwd: input.cwd, relativePath: file.name, sizeBytes: file.size },
      },
      { reportFailure: false },
    );
    if (minted._tag !== "Success") {
      const cause = squashAtomCommandFailure(minted);
      return fail(cause instanceof Error ? cause.message : "Upload could not start");
    }

    const connection = readPreparedConnection(input.environmentId);
    if (!connection) {
      return fail("Not connected");
    }

    try {
      await uploadBytes({
        url: resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl),
        file,
        mimeType: file.type || "application/octet-stream",
        onProgress: (fraction) => {
          loadedBytes[index] = file.size * fraction;
          emitProgress();
        },
      }).done;
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Upload failed");
    }
    completedFiles += 1;
    loadedBytes[index] = file.size;
    emitProgress();
    return true;
  };

  const results = await Promise.all(files.map((file, index) => uploadFile(file, index)));
  return {
    uploaded: results.filter(Boolean).length,
    failed: results.length - results.filter(Boolean).length,
  };
}
