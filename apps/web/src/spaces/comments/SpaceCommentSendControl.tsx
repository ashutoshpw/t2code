import { SendIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { spaceCommentThreadChoices } from "@t2code/client-runtime/spaces";
import type { EnvironmentId } from "@t2code/contracts";
import type { SpaceCommentDispatchMode } from "@t2code/contracts/spaces";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { useProjects, useVisibleThreadShells } from "~/state/entities";
import type { SpaceCommentSendChoice } from "./useSpaceCommentActions";

/** Where a comment goes: an existing session or a new one in a project, in a chosen mode. */
export function SpaceCommentSendControl({
  environmentId,
  label,
  trigger,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly trigger?: ReactNode;
  readonly onPick: (choice: SpaceCommentSendChoice & { readonly title: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SpaceCommentDispatchMode>("edit");
  const [query, setQuery] = useState("");
  const [now] = useState(() => Date.now());
  const shells = useVisibleThreadShells(open);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const choices = spaceCommentThreadChoices({ shells, environmentId, query, now });
  const pick = (choice: SpaceCommentSendChoice & { readonly title: string }) => {
    onPick(choice);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="xs" aria-label={label}>
            {trigger ?? (
              <>
                <SendIcon />
                {label}
              </>
            )}
          </Button>
        }
      />
      <PopoverPopup align="end" width="md">
        <div className="flex flex-col gap-3">
          <ToggleGroup
            value={[mode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "edit" || next === "message") setMode(next);
            }}
            aria-label="What the session does"
          >
            <ToggleGroupItem value="edit">Ask to edit</ToggleGroupItem>
            <ToggleGroupItem value="message">Just message</ToggleGroupItem>
          </ToggleGroup>
          <Input
            type="search"
            size="sm"
            placeholder="Find a session"
            aria-label="Find a session"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ul className="flex max-h-48 flex-col overflow-y-auto" aria-label="Sessions">
            {choices.map((choice) => (
              <li key={choice.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  onClick={() =>
                    pick({
                      mode,
                      target: { kind: "thread", threadId: choice.thread.threadId },
                      title: choice.label,
                    })
                  }
                >
                  <span className="truncate">{choice.label}</span>
                </Button>
              </li>
            ))}
          </ul>
          {projects.length > 0 ? (
            <Select
              value={null}
              onValueChange={(projectId) => {
                const project = projects.find((candidate) => candidate.id === projectId);
                if (project)
                  pick({
                    mode,
                    target: { kind: "new", projectId: project.id },
                    title: project.title,
                  });
              }}
              items={projects.map((project) => ({ value: project.id, label: project.title }))}
            >
              <SelectTrigger size="sm" aria-label="New session in">
                <SelectValue placeholder="New session in…" />
              </SelectTrigger>
              <SelectPopup>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
