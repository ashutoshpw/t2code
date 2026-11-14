import { viewTraits } from "@t2code/client-runtime/spaces";
import { ChevronDownIcon, ChevronsLeftIcon, ChevronsRightIcon, Maximize2Icon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ViewControls } from "../controls/ViewControls";
import { useDatabasePageNavigation } from "../page/databasePageLink";
import { useDatabase } from "./context";
import { NewRowMenu } from "./NewRowMenu";
import { ToolbarSearch } from "./ToolbarSearch";
import { TabIcon } from "./ViewTab";
import { ViewSettings } from "./ViewSettings";
import { ViewsPopover, type ViewListProps } from "./ViewsOverflow";
import { WriterStatus } from "./WriterStatus";

function IconAction({
  label,
  expanded,
  onClick,
  children,
}: {
  readonly label: string;
  readonly expanded?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={label}
            {...(expanded === undefined ? {} : { "aria-expanded": expanded })}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Filter, sort, search, full page, view settings and collapse, then the writer status and New. */
export function DatabaseToolbar({
  search,
  onSearch,
  viewCount,
  collapsed,
  onCollapsed,
  list,
}: {
  readonly search: string;
  readonly onSearch: (search: string) => void;
  readonly viewCount: number;
  readonly collapsed: boolean;
  readonly onCollapsed: (collapsed: boolean) => void;
  readonly list: ViewListProps;
}) {
  const { model, view, layout } = useDatabase();
  const navigation = useDatabasePageNavigation();
  const traits = viewTraits(view.type);
  if (collapsed)
    return (
      <>
        <div className="flex min-w-48 flex-1 items-center gap-0.5">
          <ViewsPopover {...list} trigger={<Button variant="ghost-muted" size="xs" />}>
            <TabIcon type={view.type} />
            <span className="max-w-40 truncate">{view.name}</span>
            <ChevronDownIcon />
          </ViewsPopover>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconAction
            label="Show views and toolbar"
            expanded={false}
            onClick={() => onCollapsed(false)}
          >
            <ChevronsRightIcon className="size-4" />
          </IconAction>
          <WriterStatus />
          {traits.newRow ? <NewRowMenu /> : null}
        </div>
      </>
    );
  return (
    <div className="flex shrink-0 items-center gap-1">
      <div className="flex items-center gap-0.5">
        <ViewControls />
        {traits.search ? <ToolbarSearch search={search} onSearch={onSearch} /> : null}
        {layout === "page" ? null : (
          <IconAction
            label="Open as full page"
            onClick={() =>
              navigation.open({
                environmentId: model.environmentId,
                spaceId: model.database.spaceId,
                databaseId: model.database.id,
                viewId: view.id,
              })
            }
          >
            <Maximize2Icon className="size-4" />
          </IconAction>
        )}
        <ViewSettings viewCount={viewCount} />
        <IconAction label="Hide views and toolbar" expanded onClick={() => onCollapsed(true)}>
          <ChevronsLeftIcon className="size-4" />
        </IconAction>
      </div>
      <WriterStatus />
      {traits.newRow ? <NewRowMenu /> : null}
    </div>
  );
}
