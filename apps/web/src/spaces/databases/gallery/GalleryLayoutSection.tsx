import { Switch } from "~/components/ui/switch";
import { knownProperty } from "@t2code/client-runtime/spaces";
import { SpacePropertyId } from "@t2code/contracts/spaces";
import { OptionSelect } from "../controls/OptionSelect";
import { LayoutRow, type LayoutSectionProps } from "../shell/layoutSection";
import type { CardSize } from "./galleryLayout";

const PAGE_CONTENT = "page_content";
const SIZES: ReadonlyArray<{ value: CardSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

export function GalleryLayoutSection({
  known,
  dataSource,
  editView,
  disabled,
}: LayoutSectionProps) {
  if (known?.type !== "gallery") return null;
  const layout = known.layout;
  const files = Object.values(dataSource.properties)
    .filter((property) => knownProperty(property)?.type === "files")
    .sort((a, b) => a.position - b.position);
  const preview = layout.cardPreview;
  const cover =
    preview?.kind === "page_content"
      ? PAGE_CONTENT
      : preview?.kind === "property" && files.some((property) => property.id === preview.propertyId)
        ? preview.propertyId
        : "none";
  return (
    <>
      <LayoutRow label="Card preview">
        <OptionSelect
          label="Card preview"
          value={cover}
          disabled={disabled}
          choices={[
            { value: "none", label: "None" },
            { value: PAGE_CONTENT, label: "Page content" },
            ...files.map((property) => ({ value: property.id as string, label: property.name })),
          ]}
          onChange={(value) =>
            editView({
              layout: {
                ...layout,
                cardPreview:
                  value === "none"
                    ? { kind: "none" }
                    : value === PAGE_CONTENT
                      ? { kind: "page_content" }
                      : { kind: "property", propertyId: SpacePropertyId.make(value) },
              },
            })
          }
        />
      </LayoutRow>
      <LayoutRow label="Card size">
        <OptionSelect
          label="Card size"
          value={layout.cardSize ?? "medium"}
          disabled={disabled}
          choices={SIZES}
          onChange={(cardSize) => editView({ layout: { ...layout, cardSize } })}
        />
      </LayoutRow>
      <LayoutRow label="Fit image">
        <Switch
          size="sm"
          aria-label="Fit image"
          checked={layout.fitImage === true}
          disabled={disabled || cover === "none"}
          onCheckedChange={(fitImage) => editView({ layout: { ...layout, fitImage } })}
        />
      </LayoutRow>
    </>
  );
}
