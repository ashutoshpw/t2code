import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { T2ProjectFile, T2_PROJECT_FILE_SCHEMA_URL } from "@t2code/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t2.json` file contents (lenient JSONC string) and the
 * decoded {@link T2ProjectFile}.
 */
export const T2ProjectFileFromJson = fromLenientJson(T2ProjectFile);

const decodeT2ProjectFile = Schema.decodeExit(T2ProjectFileFromJson);

/**
 * Decode raw `t2.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseT2ProjectFile(contents: string): T2ProjectFile | null {
  const decoded = decodeT2ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `t2.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link T2_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildT2ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T2ProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T2_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
