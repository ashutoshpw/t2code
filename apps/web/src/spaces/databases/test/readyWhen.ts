/**
 * Runs the readiness wait of a mounted view. The caller only receives the screen once this
 * returns, so a failed wait must unmount it, or the next test renders next to a stale copy.
 */
export async function readyWhen<T extends { readonly screen: AsyncDisposable }>(
  mounted: T,
  ready: (mounted: T) => unknown,
): Promise<T> {
  await using stack = new AsyncDisposableStack();
  stack.use(mounted.screen);
  await ready(mounted);
  stack.move();
  return mounted;
}
