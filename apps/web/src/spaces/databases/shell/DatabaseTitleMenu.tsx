import {
  EyeOffIcon,
  LayoutIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  SmileIcon,
} from "lucide-react";
import { useContext, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { useEnvironment } from "../../../state/environments";
import type { DatabaseBlockActions } from "../blocks/actions";
import type { DatabaseModel } from "../data/useDatabaseModel";
import { useDatabasePageNavigation } from "../page/databasePageLink";
import { OpenControlContext } from "./context";

/** The hover "..." of the database title. Read-only viewers only get "View database". */
export function DatabaseTitleMenu({
  model,
  blockActions,
  page,
  linked,
  canEditLayout,
  onEditTitle,
  onEditIcon,
}: {
  readonly model: DatabaseModel;
  readonly blockActions: DatabaseBlockActions;
  /** The full-page variant: no "View database", no "Hide title". */
  readonly page: boolean;
  readonly linked: boolean;
  readonly canEditLayout: boolean;
  readonly onEditTitle: () => void;
  readonly onEditIcon: () => void;
}) {
  const navigation = useDatabasePageNavigation();
  const openControl = useContext(OpenControlContext);
  const hideable =
    useEnvironment(model.environmentId)?.serverConfig?.environment.capabilities.spaces?.features
      ?.databaseHideTitle === true;
  // Items that move focus or open a popover run once the menu has closed, or its guards swallow them.
  const [after, setAfter] = useState<(() => void) | null>(null);
  const { permissions, database } = model;
  const editable = permissions.title && !linked;
  const layout = permissions.views && canEditLayout && openControl !== null;
  const hide = !page && permissions.block && hideable;
  const more = editable || layout || hide;
  if (page && !more) return null;
  return (
    <span className="opacity-0 transition-opacity group-hover/dbtitle:opacity-100 group-focus-within/dbtitle:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
      <Menu
        onOpenChangeComplete={(open) => {
          if (open || after === null) return;
          const run = after;
          setAfter(null);
          run();
        }}
      >
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-xs" aria-label="Database options" />}
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="start">
          {page ? null : (
            <MenuItem
              onClick={() =>
                navigation.open({
                  environmentId: model.environmentId,
                  spaceId: database.spaceId,
                  databaseId: database.id,
                })
              }
            >
              <Maximize2Icon />
              View database
            </MenuItem>
          )}
          {!page && more ? <MenuSeparator /> : null}
          {editable ? (
            <>
              <MenuItem onClick={() => setAfter(() => onEditTitle)}>
                <PencilIcon />
                Edit title
              </MenuItem>
              <MenuItem onClick={() => setAfter(() => onEditIcon)}>
                <SmileIcon />
                Edit icon
              </MenuItem>
            </>
          ) : null}
          {layout ? (
            <MenuItem onClick={() => openControl?.[1]("layout")}>
              <LayoutIcon />
              Edit layout
            </MenuItem>
          ) : null}
          {hide ? (
            <MenuItem onClick={() => blockActions.setTitleHidden(true)}>
              <EyeOffIcon />
              Hide title
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </span>
  );
}
