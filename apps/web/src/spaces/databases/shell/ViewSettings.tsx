import { ChevronLeftIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { FilterPopover } from "../controls/FilterPopover";
import { GroupPopover } from "../controls/GroupPopover";
import { LayoutPopover } from "../controls/LayoutPopover";
import { PropertiesPopover } from "../controls/PropertiesPopover";
import { SortPopover } from "../controls/SortPopover";
import { SubItemsSection } from "../controls/SubItemsSection";
import { useViewControls } from "../controls/useViewControls";
import { useOpenControl } from "./context";
import { NewViewPicker } from "./NewViewPicker";
import { DeleteViewDialog } from "./ViewTabMenu";
import { MainPage, type Page } from "./ViewSettingsMain";

const TITLES: Record<Page, string> = {
  main: "View settings",
  settings: "View settings",
  layout: "Layout",
  properties: "Property visibility",
  filter: "Filter",
  sort: "Sort",
  group: "Group",
  subItems: "Sub-items",
};

function PageBody({ page }: { readonly page: Exclude<Page, "main" | "settings"> }) {
  const { view, known, dataSource, actions, canEditView } = useViewControls();
  switch (page) {
    case "layout":
      return (
        <>
          <NewViewPicker mode="change" view={view} actions={actions} disabled={!canEditView} />
          <div className="px-3 pb-2">
            <LayoutPopover />
          </div>
        </>
      );
    case "properties":
      return <PropertiesPopover />;
    case "filter":
      return <FilterPopover />;
    case "sort":
      return <SortPopover />;
    case "group":
      return <GroupPopover />;
    case "subItems":
      return (
        <div className="w-72 max-w-[calc(100vw-2rem)]">
          <SubItemsSection
            view={view}
            known={known}
            dataSource={dataSource}
            editView={actions.editView}
            disabled={!canEditView}
          />
        </div>
      );
  }
}

/** The gear popover of the active view: one main page of settings, each opening a page of its own. */
export function ViewSettings({ viewCount }: { readonly viewCount: number }) {
  const [control, setControl] = useOpenControl();
  const { model, view, actions } = useViewControls();
  const [sub, setSub] = useState<Page | null>(null);
  const [deleteRequested, setDeleteRequested] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const open = control !== null && control !== "filter" && control !== "sort";
  const page: Page = sub ?? (control === null ? "main" : control);
  const manage = model.permissions.views && model.permissions.block;
  const close = () => {
    setControl(null);
    setSub(null);
  };
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => (next ? setControl("settings") : close())}
        onOpenChangeComplete={(done) => {
          if (!done && deleteRequested) {
            setDeleteRequested(false);
            setConfirming(true);
          }
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={<Button variant="ghost-muted" size="icon-sm" aria-label="View settings" />}
              />
            }
          >
            <Settings2Icon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">View settings</TooltipPopup>
        </Tooltip>
        <PopoverPopup align="end" padding="none">
          {page === "main" || page === "settings" ? (
            <MainPage
              viewCount={viewCount}
              manage={manage}
              go={setSub}
              onDuplicate={() => {
                void actions.duplicateView(view.id);
                close();
              }}
              onDelete={() => {
                setDeleteRequested(true);
                close();
              }}
            />
          ) : (
            <>
              <div className="flex h-9 items-center gap-1 px-2">
                <Button
                  variant="ghost-muted"
                  size="icon-xs"
                  aria-label="Back"
                  onClick={() => setSub("main")}
                >
                  <ChevronLeftIcon />
                </Button>
                <span className="text-sm font-medium">{TITLES[page]}</span>
              </div>
              <div className={page === "layout" ? undefined : "px-3 pb-3"}>
                <PageBody page={page} />
              </div>
            </>
          )}
        </PopoverPopup>
      </Popover>
      <DeleteViewDialog
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={() => void actions.deleteView(view.id)}
      />
    </>
  );
}
