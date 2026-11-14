import { DraftInput } from "~/components/ui/draft-input";
import { SPACE_FORM_DESCRIPTION_MAX } from "@t2code/contracts/spaces";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

export function FormLayoutSection({ known, editView, disabled }: LayoutSectionProps) {
  if (known?.type !== "form") return null;
  const { layout } = known;
  const count = layout.questions?.length ?? 0;
  return (
    <>
      <div className="flex flex-col gap-1 py-1 text-sm">
        <span>Description</span>
        <DraftInput
          size="compact"
          aria-label="Description"
          disabled={disabled}
          maxLength={SPACE_FORM_DESCRIPTION_MAX}
          value={layout.description ?? ""}
          onCommit={(description) => {
            const { description: _, ...rest } = layout;
            editView({ layout: description === "" ? rest : { ...rest, description } });
          }}
        />
      </div>
      <LayoutRow label="Questions">
        <span className="text-muted-foreground">
          {count === 1 ? "1 question" : `${count} questions`}
        </span>
      </LayoutRow>
    </>
  );
}
