import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { databaseStores } from "./stores";

const mocks = vi.hoisted(() => ({
  rowPageChanged: vi.fn(),
  updateRows: vi.fn(async () => ({ dataRevision: 2 })),
  pageSummaries: null as unknown,
}));
vi.mock(import("./ports"), () => ({
  databasePorts: {
    rowPageChanged: mocks.rowPageChanged,
    run: { updateRows: mocks.updateRows },
  } as never,
}));
vi.mock(import("../../../state/spaces"), () => ({
  spacesEnvironment: { changed: () => mocks.pageSummaries } as never,
}));
vi.mock(import("../../../state/presentation"), () => ({
  environmentPresentations: { presentationAtom: () => Atom.make(null) } as never,
}));
vi.mock(import("../../../components/ui/toast"), () => ({
  toastManager: { add: vi.fn() } as never,
}));

describe("grid title writes", () => {
  it("refresh the row's page summary once the write is acknowledged, mounted properties or not", async () => {
    const counter = Atom.make(0);
    mocks.pageSummaries = counter;
    const registry = AtomRegistry.make();
    const writer = databaseStores(registry).writer("env" as never);
    writer.editCell({
      dataSourceId: "ds" as never,
      pageId: "row-1" as never,
      propertyId: "title" as never,
      value: "Renamed",
    });
    writer.editCell({
      dataSourceId: "ds" as never,
      pageId: "row-2" as never,
      propertyId: "notes" as never,
      value: "x",
    });
    await writer.flush();
    expect(mocks.rowPageChanged).toHaveBeenCalledTimes(1);
    expect(mocks.rowPageChanged).toHaveBeenCalledWith(registry, "env", "row-1");
    expect(registry.get(counter)).toBe(1);
  });
});
