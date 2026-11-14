import { SpaceSharedForm } from "@t2code/contracts";
import * as C from "@t2code/contracts/spaces";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ids, sharedDatabase } from "./PageShareDatabases.testkit.ts";

export const extraIds = { relation: C.SpacePropertyId.make("rel00001") };

export const decodeForm = Schema.decodeUnknownEffect(SpaceSharedForm);

/**
 * A shared Tasks database with a form view on the shared block: title (required), status, note
 * and points are the questions. The hidden Secret column and a relation are not.
 */
export const sharedForm = Effect.fn("PageShareFormsTest.sharedForm")(function* (
  options: { readonly accept?: boolean } = {},
) {
  const f = yield* sharedDatabase();
  yield* f.kit.schema(f.dataSourceId, [
    {
      op: "addProperty",
      property: {
        id: extraIds.relation,
        name: "Rel",
        type: "relation",
        config: { dataSourceId: f.dataSourceId, limit: "many" },
      },
    },
  ]);
  const form = yield* f.createView("Form", "form", {
    layout: {
      description: "Tell us",
      questions: [
        { propertyId: C.SpacePropertyId.make("title"), required: true },
        { propertyId: ids.status },
        { propertyId: ids.note, label: "Your note", description: "Anything" },
        { propertyId: ids.points },
      ],
    },
    block: { pageId: f.host, blockId: f.blockId },
  });
  if (options.accept !== false)
    yield* f.shares.setResponses({ pageId: f.host, acceptResponses: true });
  return { ...f, formId: form.viewId };
});
