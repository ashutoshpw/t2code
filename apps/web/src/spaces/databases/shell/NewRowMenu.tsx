import { newRowCells, seedCellsForView } from "@t2code/client-runtime/spaces";
import type { SpacePageId } from "@t2code/contracts/spaces";
import { ChevronDownIcon, FileIcon, PlusIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useDatabase, useDatabaseActions } from "./context";

const localDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** `New` creates from the default template; the caret picks another template or a blank page. */
export function NewRowMenu() {
  const { model, view, known, columns, dataSource } = useDatabase();
  const actions = useDatabaseActions();
  const { templates, defaultTemplateId } = dataSource;
  const canCreate = model.permissions.rows;
  const canManage = model.permissions.schema && canCreate;

  const create = (templateId?: SpacePageId | null) =>
    void actions
      .createRow({
        cells: {
          ...seedCellsForView(known, dataSource, localDay()),
          ...newRowCells({
            filter: view.filter,
            properties: Object.fromEntries(
              columns.map((column) => [column.property.id, column.property]),
            ),
            today: localDay(),
          }),
        },
        ...(templateId === undefined ? {} : { templateId }),
      })
      .then((row) => {
        if (row !== null) actions.openRow(row.page.id);
      });
  const addTemplate = () =>
    void actions.createTemplate().then((pageId) => {
      if (pageId !== null) actions.openRow(pageId);
    });

  return (
    <div className="flex items-center gap-1">
      <Button size="xs" disabled={!canCreate} onClick={() => create()}>
        <PlusIcon />
        New
      </Button>
      {templates.length === 0 && !canManage ? null : (
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" aria-label="New row options" disabled={!canCreate} />}
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => create(null)}>
              <FileIcon />
              Empty page
            </MenuItem>
            {templates.map((template) => (
              <MenuItem key={template.pageId} onClick={() => create(template.pageId)}>
                <span className="min-w-0 flex-1 truncate">{template.title || "Untitled"}</span>
                {template.pageId === defaultTemplateId ? (
                  <span className="text-xs text-muted-foreground">Default</span>
                ) : null}
              </MenuItem>
            ))}
            {canManage ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={addTemplate}>
                  <PlusIcon />
                  New template
                </MenuItem>
                {templates.length > 0 ? (
                  <MenuSub>
                    <MenuSubTrigger>Manage templates</MenuSubTrigger>
                    <MenuSubPopup>
                      {templates.map((template) => (
                        <MenuSub key={template.pageId}>
                          <MenuSubTrigger>{template.title || "Untitled"}</MenuSubTrigger>
                          <MenuSubPopup>
                            <MenuItem onClick={() => actions.openRow(template.pageId)}>
                              Edit
                            </MenuItem>
                            <MenuItem
                              onClick={() =>
                                void actions.setDefaultTemplate(
                                  template.pageId === defaultTemplateId ? null : template.pageId,
                                )
                              }
                            >
                              {template.pageId === defaultTemplateId
                                ? "Remove as default"
                                : "Set as default"}
                            </MenuItem>
                            <MenuItem
                              variant="destructive"
                              onClick={() => void actions.deleteTemplate(template.pageId)}
                            >
                              Delete
                            </MenuItem>
                          </MenuSubPopup>
                        </MenuSub>
                      ))}
                    </MenuSubPopup>
                  </MenuSub>
                ) : null}
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
