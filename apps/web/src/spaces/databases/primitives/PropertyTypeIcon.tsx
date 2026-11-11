import { propertyTypeMeta } from "./propertyTypes";

export function PropertyTypeIcon({
  type,
  className,
}: {
  readonly type: string;
  readonly className?: string;
}) {
  const { icon: Icon } = propertyTypeMeta(type);
  return <Icon aria-hidden className={className ?? "size-3.5 shrink-0 text-muted-foreground"} />;
}
