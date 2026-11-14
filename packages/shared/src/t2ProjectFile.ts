import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { T2ProjectFile, T2_PROJECT_FILE_SCHEMA_URL } from "@t2code/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const T2ProjectFileFromJson = fromLenientJson(T2ProjectFile);

const decodeT2ProjectFile = Schema.decodeExit(T2ProjectFileFromJson);

export function parseT2ProjectFile(contents: string): T2ProjectFile | null {
  const decoded = decodeT2ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildT2ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T2ProjectFile, { onExcessProperty: "error" });
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
