import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { lazy, Suspense, useState } from "react";
import { isSpaceDatabaseBlock } from "@t2code/client-runtime/spaces";

import { DatabaseSkeleton } from "../shell/DatabaseSkeleton";
import { useDatabaseBlockHost, useDatabaseLayout } from "./DatabaseBlockHost";
import type { DatabaseBlockActions } from "./actions";

const DatabaseBlock = lazy(() => import("./DatabaseBlock"));

/** The only tiptap-aware file of the feature: it owns the wrapper and builds the block actions. */
export function DatabaseNodeView({ node, editor }: NodeViewProps) {
  const block: unknown = node.attrs.block;
  const host = useDatabaseBlockHost();
  const layout = useDatabaseLayout();
  const [actions] = useState<DatabaseBlockActions | null>(() =>
    host !== null && isSpaceDatabaseBlock(block)
      ? {
          setViews: (viewIds) =>
            host.adapter.setDatabaseViews(block.id, viewIds)(editor.state, editor.view.dispatch),
          remove: () => host.adapter.removeDatabase(block.id)(editor.state, editor.view.dispatch),
        }
      : null,
  );
  if (!isSpaceDatabaseBlock(block)) return null;
  return (
    <NodeViewWrapper
      contentEditable={false}
      data-space-block={block.id}
      data-space-database=""
      {...(layout === "page" ? { "data-space-database-page": "" } : {})}
      className="my-2"
    >
      <Suspense fallback={<DatabaseSkeleton />}>
        {actions ? (
          <DatabaseBlock
            blockId={block.id}
            databaseId={block.content.databaseId}
            viewIds={block.content.viewIds}
            actions={actions}
          />
        ) : null}
      </Suspense>
    </NodeViewWrapper>
  );
}
