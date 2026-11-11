import {
  defaultCondition,
  filterOperatorsFor,
  filterShape,
  insertAt,
  prune,
  rootGroup,
} from "@t2code/client-runtime/spaces";
import {
  SPACE_GROUPABLE_TYPES,
  SPACE_SORTABLE_TYPES,
  type SpacePropertyId,
} from "@t2code/contracts/spaces";
import {
  ArrowDownIcon,
  ArrowLeftToLineIcon,
  ArrowRightToLineIcon,
  ArrowUpIcon,
  EyeOffIcon,
  FilterIcon,
  GroupIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { useOpenControl } from "../shell/context";
import { defaultGroupBy } from "./groupOptions";
import { orderWithInserted, uniqueName } from "./propertyConfig";
import { PropertyEditorDialog } from "./PropertyEditorDialog";
import { PropertyNameField } from "./PropertyNameField";
import { useViewControls } from "./useViewControls";

type Followup = "edit" | "delete";

/** Wraps `render` as the trigger of a property's menu: rename, sort, filter, group, hide, insert, delete. */
export function PropertyMenu({
  propertyId,
  render,
}: {
  readonly propertyId: SpacePropertyId;
  readonly render: ReactElement;
}): ReactNode {
  const { known, columns, dataSource, limits, canEditView, canEditSchema, actions } =
    useViewControls();
  const [, setControl] = useOpenControl();
  const [open, setOpen] = useState(false);
  // A dialog opens once the menu has finished closing, or the menu leaves inert guards over it.
  const [followup, setFollowup] = useState<Followup | null>(null);
  const [dialog, setDialog] = useState<Followup | null>(null);
  const property = dataSource.properties[propertyId];
  const column = columns.find((entry) => entry.property.id === propertyId);
  if (property === undefined || column === undefined) return render;

  const isTitle = property.type === "title";
  const sortable = (SPACE_SORTABLE_TYPES as ReadonlyArray<string>).includes(property.type);
  const groupable = (SPACE_GROUPABLE_TYPES as ReadonlyArray<string>).includes(property.type);
  const filterable = filterOperatorsFor(property.type).length > 0 && column.known !== null;
  const atConditionLimit = filterShape(known?.filter).conditions >= limits.maxFilterConditions;
  const columnIds = columns.map((entry) => entry.property.id);
  const schemaOrder = Object.values(dataSource.properties)
    .sort((a, b) => a.position - b.position)
    .map((entry) => entry.id);
  const insert = async (side: "left" | "right") => {
    const at = columnIds.indexOf(propertyId);
    const viewBefore = side === "left" ? propertyId : (columnIds[at + 1] ?? null);
    const schemaBefore =
      side === "left" ? propertyId : (schemaOrder[schemaOrder.indexOf(propertyId) + 1] ?? null);
    const id = await actions.addProperty(
      {
        name: uniqueName(
          "Property",
          Object.values(dataSource.properties).map((p) => p.name),
        ),
        type: "text",
      },
      schemaBefore,
    );
    if (id !== null)
      actions.editView({
        properties: { order: orderWithInserted(columnIds, id, viewBefore) },
      });
  };

  return (
    <>
      <Menu
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && followup !== null) {
            setDialog(followup);
            setFollowup(null);
          }
        }}
      >
        <MenuTrigger render={render} />
        <MenuPopup align="start">
          <div className="p-1">
            <PropertyNameField
              propertyId={propertyId}
              name={property.name}
              disabled={!canEditSchema}
              stopKeys
            />
          </div>
          <MenuItem onClick={() => setFollowup("edit")}>
            <PencilIcon />
            Edit property
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            disabled={!canEditView || !sortable}
            onClick={() =>
              actions.editView({ sorts: [{ property: propertyId, direction: "ascending" }] })
            }
          >
            <ArrowUpIcon />
            Sort ascending
          </MenuItem>
          <MenuItem
            disabled={!canEditView || !sortable}
            onClick={() =>
              actions.editView({ sorts: [{ property: propertyId, direction: "descending" }] })
            }
          >
            <ArrowDownIcon />
            Sort descending
          </MenuItem>
          <MenuItem
            disabled={!canEditView || !filterable || atConditionLimit}
            onClick={() => {
              if (column.known === null || known === null) return;
              actions.editView({
                filter: prune(
                  insertAt(rootGroup(known.filter), [], defaultCondition(column.known)),
                ),
              });
              setControl("filter");
            }}
          >
            <FilterIcon />
            Filter
          </MenuItem>
          {groupable ? (
            <MenuItem
              disabled={!canEditView}
              onClick={() => {
                const by = defaultGroupBy(property.type);
                actions.editView({
                  group: { property: propertyId, ...(by === undefined ? {} : { by }) },
                });
              }}
            >
              <GroupIcon />
              Group
            </MenuItem>
          ) : null}
          {isTitle ? null : (
            <MenuItem
              disabled={!canEditView}
              onClick={() =>
                actions.editView({ properties: { set: { [propertyId]: { visible: false } } } })
              }
            >
              <EyeOffIcon />
              Hide in view
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem disabled={!canEditSchema} onClick={() => void insert("left")}>
            <ArrowLeftToLineIcon />
            Insert left
          </MenuItem>
          <MenuItem disabled={!canEditSchema} onClick={() => void insert("right")}>
            <ArrowRightToLineIcon />
            Insert right
          </MenuItem>
          {isTitle ? null : (
            <>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={!canEditSchema}
                onClick={() => setFollowup("delete")}
              >
                <Trash2Icon />
                Delete property
              </MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
      <PropertyEditorDialog
        propertyId={propertyId}
        open={dialog === "edit"}
        onOpenChange={(next) => !next && setDialog(null)}
      />
      <AlertDialog open={dialog === "delete"} onOpenChange={(next) => !next && setDialog(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {property.name}?</AlertDialogTitle>
            <AlertDialogDescription>You can restore it from Properties.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() =>
                void actions.updateSchema([{ op: "removeProperty", propertyId }]).then((result) => {
                  if (result !== null)
                    toastManager.add({
                      type: "info",
                      title: `Deleted ${property.name}`,
                      description: "Restore it from Properties.",
                    });
                })
              }
            >
              Delete property
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
