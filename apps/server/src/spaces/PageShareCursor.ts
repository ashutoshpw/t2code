// @effect-diagnostics nodeBuiltinImport:off -- AES-256-GCM sealing is a platform primitive.
import * as NodeCrypto from "node:crypto";

const TAG_BYTES = 16;
const IV_BYTES = 12;

/** What binds a sealed cursor to one share, page, block and view. */
export const cursorBinding = (shareId: string, pageId: string, blockId: string, viewId: string) =>
  `${shareId}\n${pageId}\n${blockId}\n${viewId}`;

/**
 * Seals a query cursor for a viewer: the engine cursor holds sort key values, which a public link
 * must not reveal, and opens only for the share, page, block and view it was issued for.
 */
export const seal = (key: Uint8Array, iv: Uint8Array, binding: string, cursor: string): string => {
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(binding, "utf8"));
  const body = Buffer.concat([cipher.update(cursor, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
};

/** The engine cursor inside a sealed one, or null when it was altered or issued for another scope. */
export const open = (key: Uint8Array, binding: string, sealed: string): string | null => {
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(binding, "utf8"));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
};
