import { createFileRoute, redirect } from "@tanstack/react-router";

import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";
import { validateSettingsRouteSearch } from "../components/settings/settingsScopeNavigation";

/** Scheduled tasks live at /scheduled-tasks; this keeps old links working. */
export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...validateSettingsRouteSearch(raw),
    ...validateScheduledTasksSearch(raw),
  }),
  beforeLoad: async ({ search }) => {
    throw redirect({
      to: "/scheduled-tasks",
      search: {
        ...(search.project !== undefined ? { project: search.project } : {}),
        ...(search.machine !== undefined ? { machine: search.machine } : {}),
        ...(search.checkout !== undefined ? { checkout: search.checkout } : {}),
        ...(search.environmentId !== undefined ? { environmentId: search.environmentId } : {}),
        ...(search.taskId !== undefined ? { taskId: search.taskId } : {}),
      },
      replace: true,
    });
  },
});
