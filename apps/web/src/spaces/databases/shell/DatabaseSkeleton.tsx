import { Skeleton } from "~/components/ui/skeleton";

/** Static: title bar, tab bar and six rows. */
export function DatabaseSkeleton() {
  return (
    <div role="status" aria-label="Loading database" className="space-y-2">
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-6 w-2/3" />
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-[34px] w-full" />
      ))}
    </div>
  );
}
