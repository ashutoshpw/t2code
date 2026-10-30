import { FileTextIcon } from "lucide-react";

import { cn } from "../lib/utils";

export function SpacePageGlyph({
  icon,
  className,
}: {
  icon: string | undefined;
  className?: string;
}) {
  return icon ? (
    <span aria-hidden className={cn("shrink-0 leading-none", className)}>
      {icon}
    </span>
  ) : (
    <FileTextIcon aria-hidden className={cn("shrink-0", className)} />
  );
}
