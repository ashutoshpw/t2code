import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t2code/contracts";
import type {
  SpaceCursor,
  SpaceDatabaseId,
  SpaceDatabaseListResult,
  SpaceDataSourceId,
  SpaceId,
} from "@t2code/contracts/spaces";
import { DatabaseIcon } from "lucide-react";
import { useContext, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useEnvironmentQuery } from "../../../state/query";
import { databaseErrorMessage } from "../data/errors";
import { databasePorts } from "../data/ports";
import { OptionSelect } from "./OptionSelect";

type Item = SpaceDatabaseListResult["items"][number];

export interface PickedDatabase {
  readonly databaseId: SpaceDatabaseId;
  readonly databaseTitle: string;
  readonly dataSourceId: SpaceDataSourceId;
  readonly dataSourceName: string;
}

const titleOf = (item: Item) => item.database.title.trim() || "Untitled";

/**
 * The space's live databases, the current one first, with a title filter and paging. A database
 * with several data sources asks for one before it reports a choice.
 */
export function DatabasePicker({
  environmentId,
  spaceId,
  currentDatabaseId,
  chooseDataSource = true,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly spaceId: SpaceId;
  /** Listed first. */
  readonly currentDatabaseId?: SpaceDatabaseId;
  /** False skips the data source step: the first data source stands for the database. */
  readonly chooseDataSource?: boolean;
  readonly onPick: (picked: PickedDatabase) => void;
}) {
  const registry = useContext(RegistryContext);
  const first = useEnvironmentQuery(databasePorts.listAtom(environmentId, spaceId));
  const [more, setMore] = useState<{
    readonly items: ReadonlyArray<Item>;
    readonly cursor: SpaceCursor | null;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [choosing, setChoosing] = useState<Item | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);

  const cursor = more === null ? (first.data?.nextCursor ?? null) : more.cursor;
  const all = [...(first.data?.items ?? []), ...(more?.items ?? [])].filter(
    (item) => item.database.live !== false,
  );
  const needle = filter.trim().toLowerCase();
  const items = all
    .filter((item) => needle === "" || titleOf(item).toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        Number(b.database.id === currentDatabaseId) - Number(a.database.id === currentDatabaseId),
    );

  const loadMore = async () => {
    if (cursor === null) return;
    try {
      const page = await databasePorts.listPage(registry, environmentId, spaceId, cursor);
      setMore((current) => ({
        items: [...(current?.items ?? []), ...page.items],
        cursor: page.nextCursor,
      }));
    } catch (error) {
      setFailure(databaseErrorMessage(error));
    }
  };
  const choose = (item: Item, dataSourceId: SpaceDataSourceId) => {
    const source = item.dataSources.find((entry) => entry.id === dataSourceId);
    if (source !== undefined)
      onPick({
        databaseId: item.database.id,
        databaseTitle: titleOf(item),
        dataSourceId: source.id,
        dataSourceName: source.name,
      });
  };

  if (choosing !== null)
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Data source of {titleOf(choosing)}</p>
        <OptionSelect
          label="Data source"
          value={sourceId}
          placeholder="Choose a data source"
          choices={choosing.dataSources.map((source) => ({
            value: source.id as string,
            label: source.name,
          }))}
          onChange={setSourceId}
        />
        <Button
          size="xs"
          disabled={sourceId === null}
          onClick={() => sourceId !== null && choose(choosing, sourceId as SpaceDataSourceId)}
        >
          Continue
        </Button>
      </div>
    );

  return (
    <div className="space-y-1.5">
      <Input
        size="compact"
        type="search"
        aria-label="Search databases"
        placeholder="Search databases"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div role="listbox" aria-label="Databases" className="max-h-52 space-y-0.5 overflow-y-auto">
        {items.map((item) => (
          <button
            key={item.database.id}
            type="button"
            role="option"
            aria-selected={false}
            className="flex h-7 w-full items-center gap-2 rounded-sm px-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onClick={() => {
              const [only] = item.dataSources;
              if ((item.dataSources.length === 1 || !chooseDataSource) && only !== undefined)
                choose(item, only.id);
              else setChoosing(item);
            }}
          >
            <DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{titleOf(item)}</span>
          </button>
        ))}
        {first.isPending && all.length === 0 ? (
          <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
            Loading databases
          </p>
        ) : null}
        {!first.isPending && items.length === 0 ? (
          <p role="status" className="px-2 py-1 text-xs text-muted-foreground">
            No databases
          </p>
        ) : null}
        {failure === null ? null : (
          <p role="alert" className="px-2 py-1 text-xs text-muted-foreground">
            {failure}
          </p>
        )}
        {cursor === null ? null : (
          <Button size="xs" variant="ghost" onClick={() => void loadMore()}>
            Load more
          </Button>
        )}
      </div>
    </div>
  );
}
