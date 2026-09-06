"use client";

import { CheckIcon } from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useMemo, useRef, useState } from "react";
import type { AgentSessionProjectCandidate, EnvironmentId } from "@t2code/contracts";

import { readProjects } from "../../state/entities";
import { agentSessionImport, agentSessionScan } from "../../state/agentSessions";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  createAgentHistoryImportState,
  describeAgentHistoryImportOutcome,
  filterCandidatesInWindow,
  runAgentHistoryImport,
  sinceIsoForWindow,
  type ImportWindow,
} from "../agentSessionImport/importHistory.logic";

type WindowChoice = ImportWindow;

function formatSource(source: AgentSessionProjectCandidate["sources"][number]): string {
  return source === "claudeAgent" ? "Claude" : "Codex";
}

export function ImportHistoryDialog({
  environmentId,
  environmentLabel,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const scan = useEnvironmentQuery(
    environmentId === null ? null : agentSessionScan({ environmentId, input: {} }),
  );
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const importStateRef = useRef(createAgentHistoryImportState());
  const importGenerationRef = useRef(0);
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("recent");
  const [customDate, setCustomDate] = useState("");
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState("");

  const sinceIso = sinceIsoForWindow(windowChoice, customDate);
  const candidates = useMemo(
    () => filterCandidatesInWindow(scan.data?.candidates ?? [], sinceIso),
    [scan.data, sinceIso],
  );
  const selected = candidates.filter((candidate) => !deselected.has(candidate.path));

  const runImport = async () => {
    if (environmentId === null || selected.length === 0) return;
    setIsImporting(true);
    setImportError("");
    const importGeneration = ++importGenerationRef.current;
    const importState = importStateRef.current;
    const summary = await runAgentHistoryImport({
      environmentId,
      selection: selected,
      since: sinceIso,
      state: importState,
      isCancelled: () =>
        importGeneration !== importGenerationRef.current || importState !== importStateRef.current,
      commandIdPrefix: "settings:history-import",
      listProjects: () => readProjects(),
      createProject: (request) => createProject(request),
      importThreads: (request) => importThreads(request),
    });
    if (summary.interrupted) return;
    if (summary.shouldRefreshScan) scan.refresh();
    setIsImporting(false);
    const error = describeAgentHistoryImportOutcome({
      completedCount: summary.completedCount,
      selectionCount: selected.length,
      importedThreadCount: summary.importedThreadCount,
      skippedThreadCount: summary.skippedThreadCount,
    });
    if (error !== null) {
      setImportError(error);
      return;
    }
    toastManager.add({
      type: "success",
      title:
        summary.importedThreadCount === 1
          ? "Imported 1 conversation"
          : `Imported ${summary.importedThreadCount} conversations`,
      description:
        summary.importedThreadCount === 0
          ? "No new conversation history was found for the selected projects."
          : `History is available in ${summary.completedCount === 1 ? "its project" : `${summary.completedCount} projects`} on ${environmentLabel}.`,
    });
    onOpenChange(false);
  };

  const close = () => {
    importGenerationRef.current += 1;
    onOpenChange(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>Import chat history</DialogTitle>
            <DialogDescription>
              Bring conversations from Claude Code and Codex on {environmentLabel} into T2 Code
              projects. Sending a message in an imported conversation continues it with the original
              agent.
            </DialogDescription>
          </DialogHeader>

          <div
            data-slot="dialog-panel"
            className="space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5"
          >
            <div>
              <div id="import-history-window-label" className="text-sm font-medium text-foreground">
                How far back?
              </div>
              <RadioGroup
                value={windowChoice}
                onValueChange={(value) => setWindowChoice(value as WindowChoice)}
                aria-labelledby="import-history-window-label"
                className="mt-2 grid grid-cols-1 gap-2"
              >
                <RadioPrimitive.Root
                  value="recent"
                  className={cn(
                    "relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary",
                  )}
                >
                  <RadioPrimitive.Indicator
                    className="grid size-4 shrink-0 place-items-center rounded-full border border-border data-checked:border-primary"
                    aria-hidden
                  >
                    <CheckIcon className="hidden size-3 data-checked:block text-primary" />
                  </RadioPrimitive.Indicator>
                  <span className="min-w-0 flex-1 text-sm text-foreground">
                    Last 30 days
                    <span className="block text-xs text-muted-foreground">
                      Matches the onboarding import default.
                    </span>
                  </span>
                </RadioPrimitive.Root>
                <RadioPrimitive.Root
                  value="all"
                  className={cn(
                    "relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary",
                  )}
                >
                  <RadioPrimitive.Indicator
                    className="grid size-4 shrink-0 place-items-center rounded-full border border-border data-checked:border-primary"
                    aria-hidden
                  >
                    <CheckIcon className="hidden size-3 data-checked:block text-primary" />
                  </RadioPrimitive.Indicator>
                  <span className="min-w-0 flex-1 text-sm text-foreground">
                    All time
                    <span className="block text-xs text-muted-foreground">
                      Large histories import in batches of 100 conversations per project; run import
                      again for the rest.
                    </span>
                  </span>
                </RadioPrimitive.Root>
                <RadioPrimitive.Root
                  value="custom"
                  className={cn(
                    "relative flex cursor-pointer items-center gap-3 rounded-lg bg-card px-3 py-2.5 text-left text-muted-foreground outline-none ring-1 ring-black/5 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary/8 data-checked:text-foreground data-checked:ring-2 data-checked:ring-primary dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary",
                  )}
                >
                  <RadioPrimitive.Indicator
                    className="grid size-4 shrink-0 place-items-center rounded-full border border-border data-checked:border-primary"
                    aria-hidden
                  >
                    <CheckIcon className="hidden size-3 data-checked:block text-primary" />
                  </RadioPrimitive.Indicator>
                  <span className="min-w-0 flex-1 text-sm text-foreground">Since date</span>
                  <Input
                    type="date"
                    size="sm"
                    className="w-40"
                    value={customDate}
                    onChange={(event) => setCustomDate(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label="Import conversations modified since this date"
                  />
                </RadioPrimitive.Root>
              </RadioGroup>
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-medium text-foreground">Projects</div>
                {scan.data?.truncated === true ? (
                  <div className="text-xs text-muted-foreground" role="status">
                    The scan hit its size limit, so older projects may be missing.
                  </div>
                ) : null}
              </div>
              {scan.error !== null ? (
                <p className="mt-2 text-sm text-destructive">
                  Could not check {environmentLabel} for importable history.
                </p>
              ) : candidates.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {scan.isPending
                    ? "Looking for importable history..."
                    : "No conversations found for this range."}
                </p>
              ) : (
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border/60">
                  {candidates.map((candidate) => (
                    <label
                      key={candidate.path}
                      className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0 hover:bg-accent/50"
                    >
                      <Checkbox
                        checked={!deselected.has(candidate.path)}
                        onCheckedChange={(checked) => {
                          setDeselected((previous) => {
                            const next = new Set(previous);
                            if (checked === true) next.delete(candidate.path);
                            else next.add(candidate.path);
                            return next;
                          });
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {candidate.path}
                      </span>
                      <span className="hidden shrink-0 whitespace-nowrap text-[11px] text-muted-foreground sm:block">
                        {candidate.sources.map(formatSource).join(", ")} · {candidate.threadCount}{" "}
                        {candidate.threadCount === 1 ? "conversation" : "conversations"}
                        {candidate.lastActiveAt
                          ? ` · ${formatRelativeTimeLabel(candidate.lastActiveAt)}`
                          : ""}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {importError ? <p className="text-sm text-destructive">{importError}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="ghost-muted" disabled={isImporting} onClick={close}>
              {importError ? "Close" : "Cancel"}
            </Button>
            <Button
              disabled={isImporting || selected.length === 0 || scan.error !== null}
              onClick={() => void runImport()}
            >
              {isImporting
                ? "Importing..."
                : `Import ${selected.length} ${selected.length === 1 ? "project" : "projects"}`}
            </Button>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
