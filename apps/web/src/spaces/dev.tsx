import { lazy, Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { EnvironmentId } from "@t2code/contracts";
import { SpaceBlockId, SpacePageId } from "@t2code/contracts/spaces";

import { randomUUID } from "~/lib/utils";

import "../index.css";
import { SpaceEditorAdapter, type SpaceEditorBatch } from "./adapter";

const SpaceEditor = lazy(() =>
  import("./SpaceEditor").then((module) => ({ default: module.SpaceEditor })),
);

function Prototype() {
  const [adapter] = useState(
    () =>
      new SpaceEditorAdapter({
        target: {
          environmentId: EnvironmentId.make("local-prototype"),
          pageId: SpacePageId.make("page"),
        },
        window: {
          revision: 0,
          completeParents: [null],
          blocks: [
            {
              id: SpaceBlockId.make("first"),
              parentId: null,
              order: "a",
              type: "paragraph",
              version: 1,
              content: {
                runs: [{ text: "Spaces adapter prototype", marks: [{ type: "bold", version: 1 }] }],
              },
            },
            {
              id: SpaceBlockId.make("second"),
              parentId: null,
              order: "b",
              type: "paragraph",
              version: 1,
              content: {
                runs: [
                  { text: "Select text, split, convert, move, or copy a subtree.", marks: [] },
                ],
              },
            },
          ],
        },
        maxBlocks: 200,
        maxDepth: 12,
        maxTextLength: 64000,
        maxClipboardBytes: 256000,
        allocateId: () => SpaceBlockId.make(randomUUID()),
        allocateOrder: ({ before, after }) => {
          // Prototype ranks only: insert lexically between ASCII tokens without rebalancing.
          let prefix = "";
          let lower = before ?? "";
          let upper = after;
          for (let index = 0; index < 128; index++) {
            const left = lower.charCodeAt(0) || 32;
            const right = upper?.charCodeAt(0) || 126;
            if (right - left > 1)
              return prefix + String.fromCharCode(Math.floor((left + right) / 2));
            prefix += String.fromCharCode(left);
            lower = lower.slice(1);
            upper = left === right ? (upper?.slice(1) ?? null) : null;
          }
          throw new Error("Prototype order space exhausted");
        },
      }),
  );
  const [batch, setBatch] = useState<SpaceEditorBatch | null>(null);
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-8">
      <h1>Spaces adapter feasibility</h1>
      <p>Local editor only. No server or draft persistence. Undo applies to this local history.</p>
      <Suspense fallback={<p>Loading editor…</p>}>
        <SpaceEditor adapter={adapter} onBatch={setBatch} />
      </Suspense>
      <details>
        <summary>Last mutation batch</summary>
        <pre>{JSON.stringify(batch, null, 2)}</pre>
      </details>
    </main>
  );
}

const root = document.getElementById("root");
if (import.meta.env.DEV && root) createRoot(root).render(<Prototype />);
