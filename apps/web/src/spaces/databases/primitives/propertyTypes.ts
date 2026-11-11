import {
  AlignLeftIcon,
  ArrowUpRightIcon,
  AtSignIcon,
  CalendarIcon,
  CircleChevronDownIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  ClockIcon,
  HashIcon,
  KeyRoundIcon,
  ListIcon,
  PaperclipIcon,
  PenLineIcon,
  PhoneIcon,
  SigmaIcon,
  SquareCheckIcon,
  TypeIcon,
  LinkIcon,
  type LucideIcon,
} from "lucide-react";
import type { SpacePropertyType } from "@t2code/contracts/spaces";

interface PropertyTypeMeta {
  readonly label: string;
  readonly icon: LucideIcon;
  /** Whether a user can add a property of this type (the title, rollup and formula are not creatable yet). */
  readonly creatable: boolean;
}

export const PROPERTY_TYPE_META: Record<SpacePropertyType, PropertyTypeMeta> = {
  title: { label: "Title", icon: TypeIcon, creatable: false },
  text: { label: "Text", icon: AlignLeftIcon, creatable: true },
  number: { label: "Number", icon: HashIcon, creatable: true },
  select: { label: "Select", icon: CircleChevronDownIcon, creatable: true },
  multi_select: { label: "Multi-select", icon: ListIcon, creatable: true },
  status: { label: "Status", icon: CircleDashedIcon, creatable: true },
  date: { label: "Date", icon: CalendarIcon, creatable: true },
  checkbox: { label: "Checkbox", icon: SquareCheckIcon, creatable: true },
  url: { label: "URL", icon: LinkIcon, creatable: true },
  email: { label: "Email", icon: AtSignIcon, creatable: true },
  phone: { label: "Phone", icon: PhoneIcon, creatable: true },
  files: { label: "Files and media", icon: PaperclipIcon, creatable: true },
  relation: { label: "Relation", icon: ArrowUpRightIcon, creatable: true },
  rollup: { label: "Rollup", icon: SigmaIcon, creatable: false },
  formula: { label: "Formula", icon: SigmaIcon, creatable: false },
  created_time: { label: "Created time", icon: ClockIcon, creatable: true },
  last_edited_time: { label: "Last edited time", icon: PenLineIcon, creatable: true },
  unique_id: { label: "ID", icon: KeyRoundIcon, creatable: true },
};

const UNKNOWN_META: PropertyTypeMeta = {
  label: "Unsupported",
  icon: CircleHelpIcon,
  creatable: false,
};

export function propertyTypeMeta(type: string): PropertyTypeMeta {
  return Object.hasOwn(PROPERTY_TYPE_META, type)
    ? PROPERTY_TYPE_META[type as SpacePropertyType]
    : UNKNOWN_META;
}
