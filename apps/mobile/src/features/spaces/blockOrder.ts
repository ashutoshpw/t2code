export function allocateMobileSpaceRootOrder(before: string | null) {
  if (before !== null && !/^[0-9a-f]{32}$/.test(before)) throw new Error("Unsupported block rank");
  const lower = before === null ? -1n : BigInt(`0x${before}`);
  const upper = 1n << 128n;
  if (upper - lower < 2n) throw new Error("No block rank gap; server rebalancing is required");
  return ((lower + upper) / 2n).toString(16).padStart(32, "0");
}
