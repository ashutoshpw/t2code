import { Sections, type ViewProps } from "./parts";
import { SharedCard } from "./SharedCard";

/** Rows as a single column of cards, as the app's feed; the shared viewer draws no page previews. */
export function SharedFeed(props: ViewProps) {
  return (
    <Sections props={props}>
      {(rows) => (
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3 py-1">
          {rows.map((row) => (
            <SharedCard key={row.id} props={props} row={row} />
          ))}
        </div>
      )}
    </Sections>
  );
}
