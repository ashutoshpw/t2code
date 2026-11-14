import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceDatabase } from "@t2code/contracts/spaces";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { useEnvironment } from "../../../state/environments";
import { useEnvironmentQuery } from "../../../state/query";
import { spacesEnvironment } from "../../../state/spaces";

const crumb = "truncate rounded-sm hover:text-foreground max-w-40 max-sm:hidden";

/** Space, ancestors and the home page, then the database. Until the location loads only the database shows. */
export function DatabasePageBreadcrumb({
  environmentId,
  database,
  home,
}: {
  readonly environmentId: EnvironmentId;
  readonly database: SpaceDatabase;
  readonly home: NonNullable<SpaceDatabase["home"]>;
}) {
  const version =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities.spaces?.version;
  // Each caller owns its location query; the family is created once.
  const [location] = useState(() =>
    version === 1 || version === 2
      ? spacesEnvironment.location({
          environmentId,
          input: { environmentId, pageId: home.pageId, version },
        })
      : null,
  );
  const query = useEnvironmentQuery(location);
  const current = query.isSuccess ? query.data?.current() : null;
  return (
    <nav
      aria-label="Database location"
      className="flex min-w-0 items-center gap-1 overflow-hidden text-sm text-muted-foreground"
    >
      {current ? (
        <>
          <Link
            to="/spaces/$environmentId/$spaceId"
            params={{ environmentId, spaceId: current.space.id }}
            className={crumb}
          >
            {current.space.title}
          </Link>
          {[...current.ancestors, current.page].map((page) => (
            <Fragment key={page.id}>
              <ChevronRightIcon className="size-3.5 shrink-0 max-sm:hidden" aria-hidden />
              <Link
                to="/spaces/$environmentId/$spaceId/$pageId"
                params={{ environmentId, spaceId: page.spaceId, pageId: page.id }}
                search={page.id === home.pageId ? { block: home.blockId } : {}}
                className={crumb}
              >
                {page.icon ? `${page.icon} ` : ""}
                {page.title || "Untitled page"}
              </Link>
            </Fragment>
          ))}
          <ChevronRightIcon className="size-3.5 shrink-0 max-sm:hidden" aria-hidden />
        </>
      ) : null}
      <span aria-current="page" className="truncate text-foreground">
        {database.icon ? `${database.icon} ` : ""}
        {database.title || "Untitled database"}
      </span>
    </nav>
  );
}
