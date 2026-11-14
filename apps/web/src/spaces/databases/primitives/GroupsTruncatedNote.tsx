/** The query returned only the first groups of a view that has more. */
export function GroupsTruncatedNote({ count }: { readonly count: number }) {
  return (
    <p role="status" className="px-1 text-xs text-muted-foreground">
      Showing the first {count} groups
    </p>
  );
}
