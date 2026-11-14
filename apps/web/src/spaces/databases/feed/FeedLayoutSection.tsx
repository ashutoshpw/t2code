import { OptionSelect } from "../controls/OptionSelect";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";

const BLOCKS = { "0": 0, "1": 1, "3": 3, "5": 5, "10": 10 } as const;
const CHOICES = [
  { value: "0", label: "None" },
  { value: "1", label: "1 block" },
  { value: "3", label: "3 blocks" },
  { value: "5", label: "5 blocks" },
  { value: "10", label: "10 blocks" },
] as const;

const blocksKey = (blocks: number | undefined): keyof typeof BLOCKS =>
  blocks === 0 || blocks === 1 || blocks === 5 || blocks === 10
    ? (String(blocks) as keyof typeof BLOCKS)
    : "3";

export function FeedLayoutSection({ known, editView, disabled }: LayoutSectionProps) {
  if (known?.type !== "feed") return null;
  const layout = known.layout;
  return (
    <LayoutRow label="Page preview">
      <OptionSelect<keyof typeof BLOCKS>
        label="Page preview"
        value={blocksKey(layout.previewBlocks)}
        disabled={disabled}
        choices={CHOICES}
        onChange={(value) => editView({ layout: { ...layout, previewBlocks: BLOCKS[value] } })}
      />
    </LayoutRow>
  );
}
