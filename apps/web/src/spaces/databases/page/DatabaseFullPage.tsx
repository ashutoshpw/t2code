import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { canBrowseSpaces } from "@t2code/client-runtime/state/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDatabaseId, SpaceId, SpacePageId, SpaceViewId } from "@t2code/contracts/spaces";
import { lazy, Suspense, useRef, useState, type ReactNode } from "react";

import { Alert, AlertAction, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useEnvironment } from "../../../state/environments";
import { spacesEnvironment, useSpacesAvailability } from "../../../state/spaces";
import { SpacesUnavailable } from "../../SpacesUnavailable";
import type { DatabaseBlockActions } from "../blocks/actions";
import { DatabaseBlockHostProvider, type DatabaseSurfaceHost } from "../blocks/DatabaseBlockHost";
import { useDatabaseModel, type DatabaseModel } from "../data/useDatabaseModel";
import { RowPeekContext } from "../row/rowPeekContext";
import { DatabaseSkeleton } from "../shell/DatabaseSkeleton";
import { DatabaseSurface } from "../shell/DatabaseSurface";
import { DatabasePageBreadcrumb } from "./DatabasePageBreadcrumb";
import { fullPageViewIds } from "./fullPageViews";

const RowPeek = lazy(() => import("../row/RowPeek"));

interface DatabaseFullPageProps {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  readonly databaseId: SpaceDatabaseId;
  readonly viewId?: SpaceViewId;
}

const Note = ({ children }: { readonly children: ReactNode }) => (
  <div className="space-y-2 px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>
);

function Bar({ children }: { readonly children?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 max-md:pl-24">
      <div className="min-w-0 flex-1">{children}</div>
    </header>
  );
}

type Home = NonNullable<DatabaseModel["database"]["home"]>;

function Loaded({
  model,
  home,
  viewId,
  host,
}: {
  readonly model: DatabaseModel;
  readonly home: Home;
  readonly viewId: SpaceViewId | undefined;
  readonly host: DatabaseSurfaceHost;
}) {
  const [blockActions] = useState<DatabaseBlockActions>(() => ({
    setViews: () => false,
    remove: () => false,
    setTitleHidden: () => false,
    remote: { pageId: home.pageId, blockId: home.blockId },
  }));
  return (
    <>
      <Bar>
        <DatabasePageBreadcrumb
          environmentId={model.environmentId}
          database={model.database}
          home={home}
        />
      </Bar>
      <div className="mx-auto w-full min-w-0 px-4 py-10 sm:px-12">
        <DatabaseSurface
          model={model}
          blockId={home.blockId}
          viewIds={fullPageViewIds(home, viewId, model.views)}
          actions={blockActions}
          layout="page"
          fullPage
          host={host}
          initialViewId={viewId ?? null}
        />
      </div>
    </>
  );
}

function Content({ environmentId, spaceId, databaseId, viewId }: DatabaseFullPageProps) {
  const router = useRouter();
  const { model, error, refresh } = useDatabaseModel(environmentId, databaseId);
  const [host] = useState<DatabaseSurfaceHost>(() => ({
    environmentId,
    openPage: (target) =>
      void router.navigate({
        to: "/spaces/$environmentId/$spaceId/$pageId",
        params: target,
        search: target.blockId ? { block: target.blockId } : {},
      }),
  }));
  if (model === null)
    return (
      <>
        <Bar />
        {error === null ? (
          <div className="px-4 py-10 sm:px-12">
            <DatabaseSkeleton />
          </div>
        ) : (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="xs" onClick={refresh}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        )}
      </>
    );
  const { home } = model.database;
  if (!model.database.live || home === null)
    return (
      <>
        <Bar />
        <Note>
          <p role="status">This database is in the trash or was deleted.</p>
          <button
            type="button"
            className="rounded-md px-2 py-1 underline outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() =>
              void router.navigate({
                to: "/spaces/$environmentId/$spaceId",
                params: { environmentId, spaceId },
              })
            }
          >
            Go to the space
          </button>
        </Note>
      </>
    );
  return <Loaded key={home.blockId} model={model} home={home} viewId={viewId} host={host} />;
}

export default function DatabaseFullPage(props: DatabaseFullPageProps) {
  const { environmentId, databaseId } = props;
  const availability = useSpacesAvailability(environmentId);
  const capability = useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces;
  const pageEditable = useAtomValue(spacesEnvironment.apply.permissionAtom(environmentId));
  const [peeked, setPeeked] = useState<{ key: string; pageId: SpacePageId } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const ownerKey = JSON.stringify([environmentId, databaseId]);
  const peekedPage = peeked?.key === ownerKey ? peeked.pageId : null;
  if (!canBrowseSpaces(availability)) return <SpacesUnavailable availability={availability} />;
  if (
    !(
      capability?.version === 2 &&
      capability.features?.databases === true &&
      capability.limits.databases
    )
  )
    return <Note>Databases need a newer T2 Code server.</Note>;
  const openPeek = (pageId: SpacePageId) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPeeked({ key: ownerKey, pageId });
  };
  return (
    <DatabaseBlockHostProvider host={null} layout="page" editable={pageEditable}>
      <RowPeekContext.Provider value={openPeek}>
        <div className="relative flex h-full min-h-0 min-w-0 flex-1">
          <section
            aria-label="Database"
            className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
          >
            <Content {...props} />
          </section>
          {peekedPage === null ? null : (
            <Suspense fallback={null}>
              <RowPeek
                target={{
                  environmentId,
                  spaceId: props.spaceId,
                  pageId: peekedPage,
                }}
                onClose={() => {
                  setPeeked(null);
                  const element = opener.current;
                  if (element?.isConnected) element.focus({ preventScroll: true });
                }}
              />
            </Suspense>
          )}
        </div>
      </RowPeekContext.Provider>
    </DatabaseBlockHostProvider>
  );
}
