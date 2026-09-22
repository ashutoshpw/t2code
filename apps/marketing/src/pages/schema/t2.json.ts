import type { APIRoute } from "astro";

import { buildT2ProjectFileJsonSchema } from "@t2code/shared/t2ProjectFile";

// Rendered at build time; published at https://t2.codes/schema/t2.json so
// t2.json files can reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildT2ProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
