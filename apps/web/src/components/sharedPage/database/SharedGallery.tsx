import { Sections, type ViewProps } from "./parts";
import { SharedCard } from "./SharedCard";

const MIN_WIDTH = { small: "10rem", medium: "15rem", large: "20rem" } as const;

export function SharedGallery(props: ViewProps) {
  const min = MIN_WIDTH[props.model.cardSize];
  return (
    <Sections props={props}>
      {(rows) => (
        <div
          className="grid gap-3 py-1"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}, 1fr))` }}
        >
          {rows.map((row) => (
            <SharedCard key={row.id} props={props} row={row} />
          ))}
        </div>
      )}
    </Sections>
  );
}
