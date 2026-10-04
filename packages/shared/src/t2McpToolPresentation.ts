export type T2McpToolLogo = "t2-code";

export interface T2McpToolPresentation {
  readonly displayName: string;
  readonly logo: T2McpToolLogo;
}

export type T2McpToolSummaryAction =
  | "capabilities"
  | "delegate"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "browser"
  | "device"
  | "html-preview"
  | "html-render";

export interface T2McpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t2-code" | "browser" | "device" | "pull-request";
  readonly summaryAction: T2McpToolSummaryAction;
}

function tool(
  labels: T2McpToolDefinition["labels"],
  summaryAction: T2McpToolSummaryAction,
  icon: T2McpToolDefinition["icon"] = "t2-code",
  displayName = `${labels[0]} ${labels[3]}`,
): T2McpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const T2_MCP_SERVER_ALIASES = new Set([
  "t2-code",
  "t2_code",
  "t2code",
  // Legacy upstream spellings still resolve transcripts recorded before
  // the rename.
  "t3-code",
  "t3_code",
  "t3code",
]);

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const T2_MCP_TOOLS: Readonly<Record<string, T2McpToolDefinition>> = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  create_threads: tool(["Create", "Creating", "Created", "T2 threads"], "thread-create"),
  t2_thread_start: tool(["Start", "Starting", "Started", "a T2 thread"], "thread-create"),
  t2_thread_list: tool(["List", "Listing", "Listed", "T2 threads"], "thread-list"),
  t2_thread_read: tool(["Read", "Reading", "Read", "a T2 thread"], "thread-read"),
  t2_thread_send: tool(["Send", "Sending", "Sent", "to a T2 thread"], "thread-send"),
  t2_thread_wait: tool(["Wait", "Waiting", "Waited", "for a T2 thread"], "thread-wait"),
  t2_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a T2 thread"],
    "thread-interrupt",
  ),
  t2_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  t2_worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  t2_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  t2_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  t2_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  t2_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  t2_queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  t2_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  t2_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  t2_pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  t2_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  t2_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  t2_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  t2_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  t2_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  t2_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  t2_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  t2_thread_organize: tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
  t2_thread_update: tool(["Update", "Updating", "Updated", "T2 thread metadata"], "thread-update"),
  t2_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  t2_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  t2_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  t2_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  t2_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  t2_thread_launch: tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
  t2_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  t2_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  t2_project_create: tool(["Register", "Registering", "Registered", "a project"], "project-create"),
  t2_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  t2_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  t2_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  t2_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  t2_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  t2_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
};

// Legacy tool spellings only identify older provider transcripts. Keep their
// display mapping while new sessions use T2 tool names.
const LEGACY_MCP_TOOL_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.keys(T2_MCP_TOOLS)
    .filter((name) => name.startsWith("t2_"))
    .map((name) => [`t3_${name.slice(3)}`, name]),
);
const ALL_MCP_TOOLS: Readonly<Record<string, T2McpToolDefinition>> = {
  ...T2_MCP_TOOLS,
  ...Object.fromEntries(
    Object.entries(LEGACY_MCP_TOOL_ALIASES).map(([alias, current]) => [
      alias,
      T2_MCP_TOOLS[current]!,
    ]),
  ),
};

/**
 * The T2 orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const T2_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(T2_MCP_TOOLS));

function normalizeT2McpToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/**
 * ACP agents disagree on how the injected T2 server prefixes its tools:
 * `mcp__t2-code__x` (Claude/Cursor), `t2-code.x` (Codex), plus legacy
 * `t3-code` spellings from stored transcripts, and single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveT2McpToolName(value: string): string | null {
  const label = normalizeT2McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T2_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch =
    /^(?<server>t2-code|t2_code|t2code|t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
      label,
    );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?(?:t2|t3)[-_ ]?code(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(label);
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(ALL_MCP_TOOLS, candidate)) return candidate;

  // OpenCode 2 registers one server per thread and joins its name to the tool
  // with `_`. Thread ids can hold `_` too, so take the longest known suffix.
  if (!/^(?:t2|t3)-code-/i.test(label)) return null;
  let longest: string | null = null;
  for (const toolName of Object.keys(ALL_MCP_TOOLS)) {
    if (label.endsWith(`_${toolName}`) && toolName.length > (longest?.length ?? 0)) {
      longest = toolName;
    }
  }
  return longest;
}

/** The bare tool name (`html_render`) for any provider's spelling of it. */
export function resolveT2McpToolId(toolName: string | null | undefined): string | null {
  const name = toolName == null ? null : resolveT2McpToolName(toolName);
  return name !== null && Object.hasOwn(ALL_MCP_TOOLS, name) ? name : null;
}

export function resolveT2McpToolDefinition(
  toolName: string | null | undefined,
): T2McpToolDefinition | null {
  const name = toolName == null ? null : resolveT2McpToolName(toolName);
  return name !== null && Object.hasOwn(ALL_MCP_TOOLS, name) ? ALL_MCP_TOOLS[name]! : null;
}

export function resolveT2McpToolPresentation(
  toolName: string | null | undefined,
): T2McpToolPresentation | null {
  const definition = resolveT2McpToolDefinition(toolName);
  return definition === null ? null : { displayName: definition.displayName, logo: "t2-code" };
}

export function resolveT2McpToolSummaryAction(
  toolName: string | null | undefined,
): T2McpToolSummaryAction | null {
  return resolveT2McpToolDefinition(toolName)?.summaryAction ?? null;
}
