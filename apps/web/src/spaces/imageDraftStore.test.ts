import { expect, it } from "vite-plus/test";
import { createSpaceImageStore } from "./imageDraftStore";

it("refuses image original hydration when IndexedDB is unavailable and retries the failed open without fallback", async () => {
  const store = createSpaceImageStore();
  await expect(store.load()).rejects.toThrow("IndexedDB is unavailable");
  await expect(store.load()).rejects.toThrow("IndexedDB is unavailable");
});
