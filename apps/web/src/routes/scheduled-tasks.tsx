import { createFileRoute, redirect } from "@tanstack/react-router";

import { isElectron } from "../env";
import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { validateSettingsRouteSearch } from "../components/settings/settingsScopeNavigation";
import { validateSettingsScopeSearch } from "../components/settings/settingsScope";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../components/WorkspaceBreadcrumb";
import { useNavigateToMainApp } from "../components/sidebar/mainAppLocation";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";

function ScheduledTasksRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  useEscapeToGoBack(navigateToMainApp);

  return (
    <SettingsScopeProvider
      search={validateSettingsScopeSearch(search)}
      onChange={(next) => {
        // Full replace, matching the settings layout: changing filters drops a
        // stale environmentId/taskId task selection.
        void navigate({
          to: "/scheduled-tasks",
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          resetScroll: false,
        });
      }}
    >
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
          <WorkspacePageHeader electron={isElectron}>
            <WorkspaceBreadcrumb ariaLabel="Scheduled tasks">
              <WorkspaceBreadcrumbItem current className="truncate">
                <WorkspaceBreadcrumbText>Scheduled tasks</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </WorkspacePageHeader>
          <ScheduledTasksSettings
            {...(search.environmentId !== undefined ? { environmentId: search.environmentId } : {})}
            {...(search.taskId !== undefined ? { taskId: search.taskId } : {})}
          />
        </div>
      </SidebarInset>
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/scheduled-tasks")({
  validateSearch: (raw: Record<string, unknown>) => ({
    // The settings scope mapping keeps ?environmentId=... narrowing the scope,
    // matching how the page behaved under /settings.
    ...validateSettingsRouteSearch(raw),
    ...validateScheduledTasksSearch(raw),
  }),
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ScheduledTasksRoute,
});
