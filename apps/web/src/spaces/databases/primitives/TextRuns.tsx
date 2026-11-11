import { isSafeSpaceLink } from "@t2code/client-runtime/spaces";

import { cn } from "~/lib/utils";

export function TextRuns({ runs }: { readonly runs: ReadonlyArray<unknown> }) {
  let offset = 0;
  return runs.map((run) => {
    if (typeof run !== "object" || run === null || !("text" in run)) return null;
    const key = offset;
    offset += String(run.text).length;
    const marks = "marks" in run && Array.isArray(run.marks) ? run.marks : [];
    const types = new Set(marks.map((mark: { type?: string }) => mark.type));
    const link = marks.find(
      (mark: { type?: string; href?: unknown }) =>
        mark.type === "link" && typeof mark.href === "string" && isSafeSpaceLink(mark.href),
    ) as { href: string } | undefined;
    const text = (
      <span
        className={cn(
          types.has("bold") && "font-semibold",
          types.has("italic") && "italic",
          types.has("code") && "rounded bg-muted px-1 font-mono text-xs",
        )}
      >
        {String(run.text)}
      </span>
    );
    return link ? (
      <a
        key={key}
        href={link.href}
        target="_blank"
        rel="noreferrer"
        className="underline"
        onClick={(event) => event.stopPropagation()}
      >
        {text}
      </a>
    ) : (
      <span key={key}>{text}</span>
    );
  });
}
