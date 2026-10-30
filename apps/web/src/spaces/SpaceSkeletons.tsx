import { Skeleton } from "../components/ui/skeleton";

export function SpaceDocumentSkeleton() {
  return (
    <div role="status" aria-label="Loading document" className="space-y-3">
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-5/6" />
      <Skeleton className="h-5 w-2/3" />
    </div>
  );
}

export function SpaceTitleSkeleton() {
  return <Skeleton className="h-10 w-2/3" />;
}

export function SpaceListSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-4/5" />
    </div>
  );
}
