import { RegistryContext } from "@effect/atom-react";
import type { SpacePageNavigationTarget } from "@t2code/client-runtime/spaces";
import type { SpacePageId, SpacePageSummary } from "@t2code/contracts/spaces";
import { useContext, useImperativeHandle, useState, type Ref } from "react";

import type { FakeDatabase } from "../test/fakeDatabase";
import { FIXTURE_IDS } from "../test/fixtures";
import { DatabaseHarness, fakeController, testHost, TEST_ENVIRONMENT } from "../test/harness";

import { HOST_PAGE } from "./rowLocations";
/** The host page holds the database; a row page holds a plain body. */
export function DocumentStub({ target }: { readonly target: SpacePageNavigationTarget }) {
  const [host] = useState(() => testHost(fakeController().controller));
  if (target.pageId !== HOST_PAGE) return <textarea aria-label="Body" />;
  return <DatabaseHarness host={host} initialViewIds={[FIXTURE_IDS.tableView]} layout="page" />;
}

export function TitleStub({ page }: { readonly page: SpacePageSummary }) {
  return <input readOnly aria-label="Title" value={page.title} />;
}

/** The page menu's trash and "View trash" entries, acting on the fake as the recovery owner does. */
export function recoveryStub(fake: () => FakeDatabase) {
  return function RecoveryStub({
    ref,
    pageId,
  }: {
    readonly ref?: Ref<{ trash(): void; openTrash(): void }>;
    readonly pageId?: SpacePageId;
  }) {
    const registry = useContext(RegistryContext);
    useImperativeHandle(ref, () => ({
      trash: () => {
        if (pageId) void fake().ports().trashRow(registry, TEST_ENVIRONMENT, pageId);
      },
      openTrash: () => {
        if (pageId) fake().restoreRow(registry, pageId);
      },
    }));
    return null;
  };
}
