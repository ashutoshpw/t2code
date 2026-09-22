// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";
import type {
  GitActionProgressEvent,
  GitPreparePullRequestThreadInput,
  ThreadId,
} from "@t2code/contracts";

import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
} from "@t2code/contracts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubSourceControlProvider from "../sourceControl/GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "../sourceControl/GitLabSourceControlProvider.ts";
import {
  ForgejoPullRequestSchema,
  toForgejoChangeRequest,
} from "../sourceControl/forgejoPullRequests.ts";
import type { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";

const encodeCliJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeForgejoPullRequest = Schema.decodeEffect(ForgejoPullRequestSchema);

interface FakeGhScenario {
  prListSequence?: string[];
  prListByHeadSelector?: Record<string, string>;
  prListSequenceByHeadSelector?: Record<string, string[]>;
  createdPrUrl?: string;
  defaultBranch?: string;
  pullRequest?: {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    state?: "open" | "closed" | "merged";
    isDraft?: boolean;
    isCrossRepository?: boolean;
    headRepositoryNameWithOwner?: string | null;
    headRepositoryOwnerLogin?: string | null;
  };
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  failWith?: GitHubCli.GitHubCliError;
  /** Let this many gh calls succeed before failWith kicks in (default 0 = fail immediately). */
  failAfterCalls?: number;
}

function fakeGhOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

type FakeGitTextGeneration = TextGeneration.TextGeneration["Service"];

type FakePullRequest = NonNullable<FakeGhScenario["pullRequest"]>;

function normalizeFakePullRequestSummary(raw: unknown): GitHubCli.GitHubPullRequestSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const number = record.number;
  const title = record.title;
  const url = record.url;
  const baseRefName = record.baseRefName;
  const headRefName = record.headRefName;
  const headRepository =
    typeof record.headRepository === "object" && record.headRepository !== null
      ? (record.headRepository as Record<string, unknown>)
      : null;
  const headRepositoryOwner =
    typeof record.headRepositoryOwner === "object" && record.headRepositoryOwner !== null
      ? (record.headRepositoryOwner as Record<string, unknown>)
      : null;

  if (
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof baseRefName !== "string" ||
    typeof headRefName !== "string"
  ) {
    return null;
  }

  const state =
    typeof record.state === "string"
      ? record.state === "OPEN" || record.state === "open"
        ? "open"
        : record.state === "CLOSED" || record.state === "closed"
          ? "closed"
          : "merged"
      : undefined;
  const isDraft = typeof record.isDraft === "boolean" ? record.isDraft : undefined;
  const isCrossRepository =
    typeof record.isCrossRepository === "boolean" ? record.isCrossRepository : undefined;
  const headRepositoryNameWithOwner =
    typeof record.headRepositoryNameWithOwner === "string"
      ? record.headRepositoryNameWithOwner
      : typeof headRepository?.nameWithOwner === "string"
        ? headRepository.nameWithOwner
        : undefined;
  const headRepositoryOwnerLogin =
    typeof record.headRepositoryOwnerLogin === "string"
      ? record.headRepositoryOwnerLogin
      : typeof headRepositoryOwner?.login === "string"
        ? headRepositoryOwner.login
        : undefined;

  return {
    number,
    title,
    url,
    baseRefName,
    headRefName,
    ...(state ? { state } : {}),
    ...(isDraft === true ? { isDraft: true } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function runGitSyncForFakeGh(cwd: string, args: readonly string[]): void {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new Error(
    `Failed to simulate gh checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
  );
}

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function removePath(
  targetPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(targetPath, { recursive: true, force: true });
  });
}

function makeDirectory(
  dirPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(dirPath, { recursive: true });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  {
    readonly exitCode: GitVcsDriver.ExecuteGitResult["exitCode"];
    readonly stdout: string;
    readonly stderr: string;
  },
  GitCommandError,
  GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* git.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("t2code-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

function configureRemote(
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
): Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
    yield* runGit(cwd, [
      "config",
      "--replace-all",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
    ]);
  });
}

function configureVisibleRemoteUrlWithLocalRewrite(
  cwd: string,
  remoteName: string,
  visibleUrl: string,
  localRemotePath: string,
): Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, visibleUrl]);
    yield* runGit(cwd, ["config", `url.${localRemotePath}.insteadOf`, visibleUrl]);
  });
}

function createTextGeneration(
  overrides: Partial<FakeGitTextGeneration> = {},
): TextGeneration.TextGeneration["Service"] {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generatePrContent: (input) =>
      implementation.generatePrContent(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateBranchName: (input) =>
      implementation.generateBranchName(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateThreadTitle: (input) =>
      implementation.generateThreadTitle(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
  };
}

function createGitHubCliWithFakeGh(scenario: FakeGhScenario = {}): {
  service: GitHubCli.GitHubCli["Service"];
  ghCalls: string[];
} {
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const prListQueueByHeadSelector = new Map(
    Object.entries(scenario.prListSequenceByHeadSelector ?? {}).map(([headSelector, values]) => [
      headSelector,
      [...values],
    ]),
  );
  const ghCalls: string[] = [];

  const execute: GitHubCli.GitHubCli["Service"]["execute"] = (input) => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith && ghCalls.length > (scenario.failAfterCalls ?? 0)) {
      return Effect.fail(scenario.failWith);
    }

    if (args[0] === "pr" && args[1] === "list") {
      const headSelectorIndex = args.findIndex((value) => value === "--head");
      const headSelector =
        headSelectorIndex >= 0 && headSelectorIndex < args.length - 1
          ? args[headSelectorIndex + 1]
          : undefined;
      const mappedQueue =
        typeof headSelector === "string"
          ? prListQueueByHeadSelector.get(headSelector)?.shift()
          : undefined;
      const mappedStdout =
        typeof headSelector === "string"
          ? scenario.prListByHeadSelector?.[headSelector]
          : undefined;
      const stdout = (mappedQueue ?? mappedStdout ?? prListQueue.shift() ?? "[]") + "\n";
      return Effect.succeed(fakeGhOutput(stdout));
    }

    if (args[0] === "pr" && args[1] === "create") {
      return Effect.succeed(
        fakeGhOutput(
          (scenario.createdPrUrl ?? "https://github.com/pingdotgg/codething-mvp/pull/101") + "\n",
        ),
      );
    }

    if (args[0] === "pr" && args[1] === "view") {
      const pullRequest: FakePullRequest = scenario.pullRequest ?? {
        number: 101,
        title: "Pull request",
        url: "https://github.com/pingdotgg/codething-mvp/pull/101",
        baseRefName: "main",
        headRefName: "feature/pull-request",
        state: "open",
      };
      return Effect.succeed(
        fakeGhOutput(
          JSON.stringify({
            ...pullRequest,
            ...(pullRequest.headRepositoryNameWithOwner
              ? {
                  headRepository: {
                    nameWithOwner: pullRequest.headRepositoryNameWithOwner,
                  },
                }
              : {}),
            ...(pullRequest.headRepositoryOwnerLogin
              ? {
                  headRepositoryOwner: {
                    login: pullRequest.headRepositoryOwnerLogin,
                  },
                }
              : {}),
          }) + "\n",
        ),
      );
    }

    if (args[0] === "pr" && args[1] === "checkout") {
      return Effect.try({
        try: () => {
          const headBranch = scenario.pullRequest?.headRefName;
          if (headBranch) {
            const existingBranch = NodeChildProcess.spawnSync(
              "git",
              ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
              {
                cwd: input.cwd,
                encoding: "utf8",
              },
            );
            if (existingBranch.status === 0) {
              runGitSyncForFakeGh(input.cwd, ["checkout", headBranch]);
            } else {
              runGitSyncForFakeGh(input.cwd, ["checkout", "-b", headBranch]);
            }
          }
          return fakeGhOutput("");
        },
        catch: (error) =>
          GitHubCli.isGitHubCliError(error)
            ? error
            : new GitHubCli.GitHubCliCommandError({
                command: "gh",
                cwd: input.cwd,
                cause: error,
              }),
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      const repository = args[2];
      if (typeof repository === "string" && args.includes("nameWithOwner,url,sshUrl")) {
        const cloneUrls = scenario.repositoryCloneUrls?.[repository];
        if (!cloneUrls) {
          return Effect.fail(
            new GitHubCli.GitHubCliCommandError({
              command: "gh",
              cwd: input.cwd,
              cause: new Error(`Unexpected repository lookup: ${repository}`),
            }),
          );
        }
        return Effect.succeed(
          fakeGhOutput(
            JSON.stringify({
              nameWithOwner: repository,
              url: cloneUrls.url,
              sshUrl: cloneUrls.sshUrl,
            }) + "\n",
          ),
        );
      }
      return Effect.succeed(fakeGhOutput(`${scenario.defaultBranch ?? "main"}\n`));
    }

    return Effect.fail(
      new GitHubCli.GitHubCliCommandError({
        command: "gh",
        cwd: input.cwd,
        cause: new Error(`Unexpected gh command: ${args.join(" ")}`),
      }),
    );
  };

  return {
    service: {
      execute,
      listOpenPullRequests: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            "--head",
            input.headSelector,
            "--state",
            "open",
            "--limit",
            String(input.limit ?? 1),
            "--json",
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) => JSON.parse(result.stdout) as unknown[]),
          Effect.map((raw) =>
            raw
              .map((entry) => normalizeFakePullRequestSummary(entry))
              .filter((entry): entry is GitHubCli.GitHubPullRequestSummary => entry !== null),
          ),
        ),
      createPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            "--base",
            input.baseBranch,
            "--head",
            input.headSelector,
            "--title",
            input.title,
            "--body-file",
            input.bodyFile,
          ],
        }).pipe(Effect.asVoid),
      getDefaultBranch: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        }).pipe(
          Effect.map((result) => {
            const value = result.stdout.trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            input.reference,
            "--json",
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) => JSON.parse(result.stdout) as GitHubCli.GitHubPullRequestSummary),
        ),
      getRepositoryCloneUrls: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout))),
      createRepository: (input) =>
        Effect.fail(
          new GitHubCli.GitHubCliCommandError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error(`Unexpected repository create: ${input.repository}`),
          }),
        ),
      checkoutPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
        }).pipe(Effect.asVoid),
    },
    ghCalls,
  };
}

function runStackedAction(
  manager: GitManager.GitManager["Service"],
  input: {
    cwd: string;
    action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManager.GitManager["Service"]["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

function resolvePullRequest(
  manager: GitManager.GitManager["Service"],
  input: { cwd: string; reference: string },
) {
  return manager.resolvePullRequest(input);
}

function preparePullRequestThread(
  manager: GitManager.GitManager["Service"],
  input: GitPreparePullRequestThreadInput,
) {
  return manager.preparePullRequestThread(input);
}

function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  sourceControlProvider?: SourceControlProvider["Service"];
  textGeneration?: Partial<FakeGitTextGeneration>;
  serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  setupScriptRunner?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  gitConfigReads?: string[];
}) {
  const { service: gitHubCli, ghCalls } = createGitHubCliWithFakeGh(input?.ghScenario);
  const textGeneration = createTextGeneration(input?.textGeneration);
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-manager-test-",
  });

  const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest(input?.serverSettings);

  const vcsDriverLayer = input?.gitConfigReads
    ? Layer.effect(
        GitVcsDriver.GitVcsDriver,
        GitVcsDriver.make.pipe(
          Effect.map((service) =>
            GitVcsDriver.GitVcsDriver.of({
              ...service,
              readConfigValue: (cwd, key) =>
                Effect.sync(() => input.gitConfigReads?.push(key)).pipe(
                  Effect.andThen(service.readConfigValue(cwd, key)),
                ),
            }),
          ),
        ),
      ).pipe(
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(serverConfigLayer),
      )
    : GitVcsDriver.layer.pipe(
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(serverConfigLayer),
      );
  const sourceControlRegistryLayer = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    (input?.sourceControlProvider === undefined
      ? GitHubSourceControlProvider.make
      : Effect.succeed(input.sourceControlProvider)
    ).pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          resolveLink: (input) => provider.resolveLink?.(input),
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
      Effect.provide(Layer.succeed(GitHubCli.GitHubCli, gitHubCli)),
    ),
  );

  const managerLayer = Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, textGeneration),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
    }),
    Layer.succeed(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
      input?.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    vcsDriverLayer,
    serverSettingsLayer,
  ).pipe(Layer.provideMerge(sourceControlRegistryLayer), Layer.provideMerge(NodeServices.layer));

  return GitManager.make.pipe(
    Effect.provide(managerLayer),
    Effect.map((manager) => ({ manager, ghCalls })),
  );
}

const asThreadId = (threadId: string) => threadId as ThreadId;

const GitManagerTestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-manager-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("status includes draft PR metadata when branch already has a draft PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-open-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 13,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/13",
                baseRefName: "main",
                headRefName: "feature/status-open-pr",
                isDraft: true,
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.isRepo).toBe(true);
      expect(status.hasPrimaryRemote).toBe(true);
      expect(status.isDefaultRef).toBe(false);
      expect(status.refName).toBe("feature/status-open-pr");
      expect(status.pr).toEqual({
        number: 13,
        title: "Existing PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/13",
        baseRef: "main",
        headRef: "feature/status-open-pr",
        state: "open",
        isDraft: true,
        updatedAt: null,
      });
    }),
  );

  it.effect("status trims PR metadata returned by gh before publishing it", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-trimmed-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-trimmed-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 14,
                title: "  Existing PR title  \n",
                url: " https://github.com/pingdotgg/codething-mvp/pull/14 ",
                baseRefName: " main ",
                headRefName: "\tfeature/status-trimmed-pr\t",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 14,
        title: "Existing PR title",
        url: "https://github.com/pingdotgg/codething-mvp/pull/14",
        baseRef: "main",
        headRef: "feature/status-trimmed-pr",
        state: "open",
        updatedAt: null,
      });
    }),
  );

  it.effect("status ignores invalid gh pr list entries and keeps valid ones", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-valid-pr-entry"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-valid-pr-entry"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 15,
                title: "  Valid PR title  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/15 ",
                baseRefName: " main ",
                headRefName: "\tfeature/status-valid-pr-entry\t",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 15,
        title: "Valid PR title",
        url: "https://github.com/pingdotgg/codething-mvp/pull/15",
        baseRef: "main",
        headRef: "feature/status-valid-pr-entry",
        state: "open",
        updatedAt: null,
      });
    }),
  );

  it.effect("status preserves lowercase merged and closed PR states from gh json", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-lowercase-state"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-lowercase-state"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 16,
                title: "Closed PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/16",
                baseRefName: "main",
                headRefName: "feature/status-lowercase-state",
                state: "closed",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                number: 17,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/17",
                baseRefName: "main",
                headRefName: "feature/status-lowercase-state",
                state: "merged",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 17,
        title: "Merged PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/17",
        baseRef: "main",
        headRef: "feature/status-lowercase-state",
        state: "merged",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
    }),
  );

  it.effect("status returns an explicit non-repo result for non-git directories", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("t2code-git-manager-non-repo-");
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }),
  );

  it.effect("status returns an explicit non-repo result for deleted directories", () =>
    Effect.gen(function* () {
      const rootDir = yield* makeTempDir("t2code-git-manager-missing-dir-");
      const cwd = NodePath.join(rootDir, "deleted-repo");
      yield* makeDirectory(cwd);
      yield* removePath(cwd);
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }),
  );

  it.effect("status briefly caches repeated lookups for the same cwd", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-cache"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-cache"]);

      const existingPr = {
        number: 113,
        title: "Cached PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/113",
        baseRefName: "main",
        headRefName: "feature/status-cache",
      };
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr]), JSON.stringify([existingPr])],
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      const second = yield* manager.status({ cwd: repoDir });

      expect(first.pr?.number).toBe(113);
      expect(second.pr?.number).toBe(113);
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
    }),
  );

  it.effect("a warm PR cache does not reread repository identity for status", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-identity-cache"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-identity-cache"]);

      const gitConfigReads: string[] = [];
      const { manager } = yield* makeManager({ gitConfigReads });

      yield* manager.remoteStatus({ cwd: repoDir }, { refreshUpstream: false });
      gitConfigReads.length = 0;
      yield* manager.remoteStatus({ cwd: repoDir }, { refreshUpstream: false });

      const identityReads = gitConfigReads.filter(
        (key) =>
          key === "branch.feature/status-identity-cache.remote" || key === "remote.origin.url",
      );
      expect(identityReads).toHaveLength(0);
    }),
  );

  it.effect("turn-end refresh finds a new PR and keeps known PRs cached", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/turn-refresh", "origin/main"]);
      yield* runGit(repoDir, ["push", "origin", "feature/turn-refresh"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            "[]",
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 114,
                title: "Opened during the turn",
                url: "https://github.com/pingdotgg/codething-mvp/pull/114",
                baseRefName: "main",
                headRefName: "feature/turn-refresh",
              },
            ]),
          ],
        },
      });
      expect((yield* manager.remoteStatus({ cwd: repoDir }))?.pr).toBeNull();
      expect(
        (yield* manager.remoteStatus({ cwd: repoDir }, { refreshUpstream: false }))?.pr,
      ).toBeNull();

      const refreshed = yield* manager.remoteStatus(
        { cwd: repoDir },
        { refreshUpstream: false, refreshMissingPullRequest: true },
      );
      expect(refreshed?.pr?.number).toBe(114);
      yield* manager.remoteStatus(
        { cwd: repoDir },
        { refreshUpstream: false, refreshMissingPullRequest: true },
      );
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
    }),
  );

  it.effect("turn-end refresh preserves failed PR lookup backoff", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/rate-limited"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/rate-limited"]);
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
        },
      });
      yield* manager.remoteStatus({ cwd: repoDir });
      const callsAfterFailure = ghCalls.length;
      yield* manager.remoteStatus(
        { cwd: repoDir },
        { refreshUpstream: false, refreshMissingPullRequest: true },
      );
      expect(callsAfterFailure).toBeGreaterThan(0);
      expect(ghCalls).toHaveLength(callsAfterFailure);
    }),
  );

  it.effect("status skips the provider lookup for a branch that was never pushed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/never-pushed"]);

      const { manager, ghCalls } = yield* makeManager();

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.refName).toBe("feature/never-pushed");
      expect(status.pr).toBeNull();
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(0);
    }),
  );

  it.effect("branch PR lookup returns null when the repository has no remotes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const { manager, ghCalls } = yield* makeManager();

      const pullRequest = yield* manager.branchPullRequest({ cwd: repoDir, branch: "main" });

      expect(pullRequest).toBeNull();
      expect(ghCalls).toHaveLength(0);
    }),
  );

  it.effect("branch PR lookup uses a saved tracked branch without changing checkout", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/saved-branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/saved-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 216,
                title: "Saved branch PR",
                url: "https://github.com/pingdotgg/t2code/pull/216",
                baseRefName: "main",
                headRefName: "feature/saved-branch",
                state: "OPEN",
                updatedAt: "2026-04-03T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/saved-branch",
      });

      expect(pullRequest).toMatchObject({
        number: 216,
        title: "Saved branch PR",
        url: "https://github.com/pingdotgg/t2code/pull/216",
        baseRef: "main",
        headRef: "feature/saved-branch",
        state: "open",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-03T15:00:00.000Z",
      });
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    }),
  );

  it.effect("branch PR lookup uses the default branch from a non-origin remote", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "upstream", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "develop"]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "develop"]);
      yield* runGit(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
      yield* runGit(repoDir, ["remote", "set-head", "upstream", "develop"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 221,
                title: "Merged main PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/221",
                baseRefName: "develop",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2026-04-07T15:00:00Z",
                updatedAt: "2026-04-08T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({ cwd: repoDir, branch: "main" });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: "2026-04-07T15:00:00Z",
        updatedAt: "2026-04-08T15:00:00.000Z",
      });
    }),
  );

  it.effect("branch PR lookup uses the saved name after the local branch is deleted", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["branch", "feature/deleted-local-branch/child"]);
      yield* runGit(repoDir, [
        "branch",
        "--set-upstream-to",
        "origin/main",
        "feature/deleted-local-branch/child",
      ]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 217,
                title: "Deleted local branch PR",
                url: "https://github.com/pingdotgg/t2code/pull/217",
                baseRefName: "main",
                headRefName: "feature/deleted-local-branch",
                state: "MERGED",
                updatedAt: "2026-04-04T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/deleted-local-branch",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-04T15:00:00.000Z",
      });
      expect(ghCalls.some((call) => call.includes("--head feature/deleted-local-branch"))).toBe(
        true,
      );
    }),
  );

  it.effect("branch PR lookup recovers a deleted fork branch from its remote-tracking ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
      yield* runGit(repoDir, ["checkout", "-b", "feature/deleted-fork-branch"]);
      yield* runGit(repoDir, ["push", "-u", "team/fork", "feature/deleted-fork-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/deleted-fork-branch"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "team/fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "contributor:feature/deleted-fork-branch": JSON.stringify([
              {
                number: 218,
                title: "Deleted fork branch PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/218",
                baseRefName: "main",
                headRefName: "feature/deleted-fork-branch",
                state: "MERGED",
                updatedAt: "2026-04-05T15:00:00Z",
                isCrossRepository: true,
                headRepository: { nameWithOwner: "contributor/codething-mvp" },
                headRepositoryOwner: { login: "contributor" },
              },
            ]),
          },
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/deleted-fork-branch",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-05T15:00:00.000Z",
      });
      expect(
        ghCalls.some((call) => call.includes("--head contributor:feature/deleted-fork-branch")),
      ).toBe(true);
    }),
  );

  it.effect("branch PR lookup rejects ambiguous deleted-branch remote refs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["push", "origin", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["push", "fork", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/ambiguous-remote"]);
      const { manager, ghCalls } = yield* makeManager();

      const error = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/ambiguous-remote" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        detail: "Multiple remotes track feature/ambiguous-remote. Its pull request is ambiguous.",
      });
      expect(ghCalls).toHaveLength(0);
    }),
  );

  it.effect("branch PR lookup does not reuse a cached PR after the remote is repointed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const originalRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originalRemoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/repointed-lookup"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/repointed-lookup"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:old-owner/old-repository.git",
        originalRemoteDir,
      );
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 219,
                title: "Old repository PR",
                url: "https://github.com/old-owner/old-repository/pull/219",
                baseRefName: "main",
                headRefName: "feature/repointed-lookup",
                state: "MERGED",
                updatedAt: "2026-04-06T15:00:00Z",
              },
            ]),
            "[]",
          ],
        },
      });

      const first = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/repointed-lookup",
      });
      expect(first?.state).toBe("merged");

      const replacementRemoteDir = yield* createBareRemote();
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:new-owner/new-repository.git",
        replacementRemoteDir,
      );

      const second = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/repointed-lookup",
      });

      expect(second).toBeNull();
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
    }),
  );

  it.effect("branch PR lookup shares the status cache for the same repository identity", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/shared-pr-cache"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/shared-pr-cache"]);
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 220,
                title: "Shared cache PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/220",
                baseRefName: "main",
                headRefName: "feature/shared-pr-cache",
                state: "MERGED",
                updatedAt: "2026-04-07T15:00:00Z",
              },
            ]),
            encodeCliJson([
              {
                number: 221,
                title: "New PR on the same branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/221",
                baseRefName: "main",
                headRefName: "feature/shared-pr-cache",
                state: "OPEN",
                updatedAt: "2026-04-08T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/shared-pr-cache",
      });

      expect(status.pr?.state).toBe("merged");
      expect(pullRequest?.state).toBe("merged");
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
      const refreshed = yield* manager.branchPullRequest(
        { cwd: repoDir, branch: "feature/shared-pr-cache" },
        { refresh: true },
      );
      expect(refreshed).toMatchObject({
        number: 221,
        state: "open",
        repositoryKey: "github.com/pingdotgg/codething-mvp",
      });
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
    }),
  );

  it.effect("branch PR lookup propagates provider failures", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/lookup-failure"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/lookup-failure"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("gh is not available on PATH"),
          }),
        },
      });

      const error = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/lookup-failure" })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SourceControlProviderError");
      const refreshError = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/lookup-failure" }, { refresh: true })
        .pipe(Effect.flip);
      expect(refreshError._tag).toBe("SourceControlProviderError");
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
    }),
  );

  it.effect("status finds a merged PR after its remote branch was deleted", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/merged-branch-deleted"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/merged-branch-deleted"]);

      // GitHub commonly deletes a pull request's head branch after merge. Git
      // removes the remote-tracking ref, but preserves the local branch's
      // remote and merge configuration as evidence that it was published.
      yield* runGit(repoDir, ["push", "origin", "--delete", "feature/merged-branch-deleted"]);
      const configuredRemote = yield* runGit(repoDir, [
        "config",
        "--get",
        "branch.feature/merged-branch-deleted.remote",
      ]);
      const configuredMerge = yield* runGit(repoDir, [
        "config",
        "--get",
        "branch.feature/merged-branch-deleted.merge",
      ]);
      const trackingRef = yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin/feature/merged-branch-deleted",
      ]);
      expect(configuredRemote.stdout.trim()).toBe("origin");
      expect(configuredMerge.stdout.trim()).toBe("refs/heads/feature/merged-branch-deleted");
      expect(trackingRef.stdout.trim()).toBe("");

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 215,
                title: "Merged branch was deleted",
                url: "https://github.com/pingdotgg/t2code/pull/215",
                baseRefName: "main",
                headRefName: "feature/merged-branch-deleted",
                state: "MERGED",
                mergedAt: "2026-04-02T15:00:00Z",
                updatedAt: "2026-04-02T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.hasUpstream).toBe(false);
      expect(status.pr).toEqual({
        number: 215,
        title: "Merged branch was deleted",
        url: "https://github.com/pingdotgg/t2code/pull/215",
        baseRef: "main",
        headRef: "feature/merged-branch-deleted",
        state: "merged",
        updatedAt: "2026-04-02T15:00:00.000Z",
      });
      expect(ghCalls.filter((call) => call.startsWith("pr list ")).length).toBeGreaterThan(0);
    }),
  );

  it.effect("status still looks up PRs for a branch pushed without --set-upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pushed-no-upstream"]);
      // No `-u`, so the remote-tracking ref exists but branch.<name>.merge does
      // not. Most terminal and agent pushes land this way, and they can still
      // have a PR, so the skip must not trigger here.
      yield* runGit(repoDir, ["push", "origin", "feature/pushed-no-upstream"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 214,
                title: "Pushed without upstream",
                url: "https://github.com/pingdotgg/t2code/pull/214",
                baseRefName: "main",
                headRefName: "feature/pushed-no-upstream",
                state: "OPEN",
                updatedAt: "2026-04-01T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.number).toBe(214);
      expect(ghCalls.filter((call) => call.startsWith("pr list ")).length).toBeGreaterThan(0);
    }),
  );

  it("backs off repeated PR lookup failures past the healthy refresh cadence", () => {
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(1))).toBe(20_000);
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(2))).toBe(40_000);
    // The point of the backoff: by the third retry a failing branch must not be
    // asking more often than a healthy one, which refreshes every 2 minutes.
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(4))).toBeGreaterThan(120_000);
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(20))).toBe(900_000);
  });

  it.each([
    [
      "https://github.example.com/team/repository/pull/42?tab=files",
      "github.example.com/team/repository",
    ],
    [
      "https://gitlab.example.com/group/subgroup/repository/-/merge_requests/42",
      "gitlab.example.com/group/subgroup/repository",
    ],
    ["https://bitbucket.org/team/repository/pull-requests/42", "bitbucket.org/team/repository"],
    [
      "https://dev.azure.com/org/project/_git/repository/pullrequest/42",
      "dev.azure.com/org/project/_git/repository",
    ],
    [
      "https://org.visualstudio.com/project/_git/repository/pullrequest/42",
      "org.visualstudio.com/project/_git/repository",
    ],
    [
      "https://gitlab.example/group/pull/123/repository/-/merge_requests/42",
      "gitlab.example/group/pull/123/repository",
    ],
    ["https://github.example.com/team/repository/issues/42", null],
  ] as const)("reads the repository from the returned PR URL %s", (url, expected) => {
    expect(GitManager.pullRequestRepositoryKey(url)).toBe(expected);
  });

  it.effect("distinguishes Enterprise forks with the same head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature"]);
      yield* runGit(repoDir, ["push", "-u", "fork", "feature"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.example.com:team/repository.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.example.com:alice/repository.git",
        forkDir,
      );
      const output = encodeCliJson([
        {
          number: 2,
          title: "Another fork",
          url: "https://github.example.com/team/repository/pull/2",
          baseRefName: "main",
          headRefName: "feature",
          state: "OPEN",
          updatedAt: "2026-04-08T15:00:00Z",
          isCrossRepository: true,
          headRepository: { nameWithOwner: "bob/repository" },
          headRepositoryOwner: { login: "bob" },
        },
        {
          number: 1,
          title: "This fork",
          url: "https://github.example.com/team/repository/pull/1",
          baseRefName: "main",
          headRefName: "feature",
          state: "OPEN",
          updatedAt: "2026-04-07T15:00:00Z",
          isCrossRepository: true,
          headRepository: { nameWithOwner: "alice/repository" },
          headRepositoryOwner: { login: "alice" },
        },
      ]);
      const { manager } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            "alice:feature": output,
            "fork:feature": output,
            feature: output,
          },
        },
      });
      expect(yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature" })).toMatchObject({
        number: 1,
        repositoryKey: "github.example.com/team/repository",
      });
    }),
  );

  it.effect.each([
    "git@gitlab.com:Group/Subgroup/Fork.git",
    "https://gitlab.com/Group/Subgroup/Fork.git",
  ])("matches nested GitLab forks through the adapter for %s", (remoteUrl) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      const branch = "feature/NestedGroups";
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", branch]);
      yield* runGit(repoDir, ["push", "-u", "fork", branch]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@gitlab.com:Group/Upstream/Repository.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(repoDir, "fork", remoteUrl, forkDir);
      const output = encodeCliJson([
        {
          iid: 2,
          title: "Another subgroup's fork",
          web_url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/2",
          target_branch: "main",
          source_branch: branch,
          state: "opened",
          updated_at: "2026-04-08T15:00:00Z",
          source_project_id: 102,
          target_project_id: 100,
          source_project: { path_with_namespace: "Group/Other/Fork" },
        },
        {
          iid: 1,
          title: "This subgroup's fork",
          web_url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/1",
          target_branch: "main",
          source_branch: branch,
          state: "opened",
          updated_at: "2026-04-07T15:00:00Z",
          source_project_id: 101,
          target_project_id: 100,
          source_project: { path_with_namespace: "Group/Subgroup/Fork" },
        },
      ]);
      const calls: VcsProcess.VcsProcessInput[] = [];
      const provider = yield* GitLabSourceControlProvider.make.pipe(
        Effect.provide(
          GitLabCli.layer.pipe(
            Layer.provide(
              Layer.mock(VcsProcess.VcsProcess)({
                run: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return fakeGhOutput(output);
                  }),
              }),
            ),
          ),
        ),
      );
      const { manager } = yield* makeManager({ sourceControlProvider: provider });

      expect(yield* manager.branchPullRequest({ cwd: repoDir, branch })).toMatchObject({
        number: 1,
        repositoryKey: "gitlab.com/group/upstream/repository",
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.command).toBe("glab");
        expect(call.args).toEqual([
          "mr",
          "list",
          "--source-branch",
          branch,
          "--all",
          "--per-page",
          "20",
          "--output",
          "json",
        ]);
      }
    }),
  );

  it.effect(
    "status ignores unrelated fork PRs when the current branch tracks the same repository",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t2code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 1661,
                  title: "Fork PR from main",
                  url: "https://github.com/pingdotgg/t2code/pull/1661",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "OPEN",
                  updatedAt: "2026-04-01T15:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "lnieuwenhuis/t2code",
                  },
                  headRepositoryOwner: {
                    login: "lnieuwenhuis",
                  },
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("main");
        expect(status.pr).toBeNull();
      }),
  );

  it.effect(
    "status detects cross-repo PRs from the upstream remote URL owner",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t2code-git-manager-");
        yield* initRepo(repoDir);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "fork-pr.txt"), "fork pr\n");
        yield* runGit(repoDir, ["add", "fork-pr.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "t2code/pr-488/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:jasonLaster/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 488,
                  title: "Rebase this PR on latest main",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/488",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "jasonLaster/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "jasonLaster",
                  },
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("t2code/pr-488/statemachine");
        expect(status.pr).toEqual({
          number: 488,
          title: "Rebase this PR on latest main",
          url: "https://github.com/pingdotgg/codething-mvp/pull/488",
          baseRef: "main",
          headRef: "statemachine",
          state: "open",
          updatedAt: "2026-03-10T07:00:00.000Z",
        });
        expect(ghCalls).toContain(
          "pr list --head jasonLaster:statemachine --state all --limit 20 --json number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        );
      }),
    20_000,
  );

  it.effect(
    "status preserves a fork PR whose head is named after the default branch",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t2code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "fork-seed", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "t2code/pr-777/main"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/main"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:contributor/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "contributor:main": JSON.stringify([
                {
                  number: 777,
                  title: "Fork PR from main",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/777",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "contributor/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "contributor",
                  },
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("t2code/pr-777/main");
        expect(status.pr).toEqual({
          number: 777,
          title: "Fork PR from main",
          url: "https://github.com/pingdotgg/codething-mvp/pull/777",
          baseRef: "main",
          headRef: "main",
          state: "open",
          updatedAt: "2026-03-10T07:00:00.000Z",
        });
        expect(ghCalls).toContain(
          "pr list --head contributor:main --state all --limit 20 --json number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        );
      }),
    20_000,
  );

  it.effect(
    "status ignores synthetic local branch aliases when the upstream remote name contains slashes",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t2code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* configureRemote(repoDir, "origin", originDir, "origin");
        yield* configureRemote(repoDir, "my-org/upstream", upstreamDir, "my-org/upstream");

        yield* runGit(repoDir, ["checkout", "-b", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "git@github.com:pingdotgg/codething-mvp.git",
          originDir,
        );
        yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "my-org/upstream",
          "ssh://git@github.com/pingdotgg/codething-mvp.git",
          upstreamDir,
        );
        yield* runGit(repoDir, ["config", "remote.my-org/upstream.pushurl", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "effect-atom"]);
        yield* runGit(repoDir, ["checkout", "--track", "my-org/upstream/effect-atom"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "effect-atom": JSON.stringify([
                {
                  number: 1618,
                  title: "Correct PR",
                  url: "https://github.com/pingdotgg/t2code/pull/1618",
                  baseRefName: "main",
                  headRefName: "effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-03-01T10:00:00Z",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t2code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "pingdotgg:effect-atom": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "my-org/upstream:effect-atom": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "pingdotgg:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t2code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "my-org/upstream:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t2code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("upstream/effect-atom");
        expect(status.pr).toEqual({
          number: 1618,
          title: "Correct PR",
          url: "https://github.com/pingdotgg/t2code/pull/1618",
          baseRef: "main",
          headRef: "effect-atom",
          state: "open",
          updatedAt: "2026-03-01T10:00:00.000Z",
        });
        expect(ghCalls.some((call) => call.includes("pr list --head upstream/effect-atom "))).toBe(
          false,
        );
        expect(
          ghCalls.some((call) => call.includes("pr list --head pingdotgg:upstream/effect-atom ")),
        ).toBe(false);
        expect(
          ghCalls.some((call) =>
            call.includes("pr list --head my-org/upstream:upstream/effect-atom "),
          ),
        ).toBe(false);
      }),
    20_000,
  );

  it.effect("status returns merged PR state when latest PR was merged", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-merged-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 22,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/22",
                baseRefName: "main",
                headRefName: "feature/status-merged-pr",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-merged-pr");
      expect(status.pr).toEqual({
        number: 22,
        title: "Merged PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/22",
        baseRef: "main",
        headRef: "feature/status-merged-pr",
        state: "merged",
        updatedAt: "2026-01-30T10:00:00.000Z",
      });
    }),
  );

  it.effect("status hides merged PRs on the default branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 23,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/23",
                baseRefName: "feature/status-default-branch-target",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("main");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("status does not inherit a merged PR from a feature branch's default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/from-main", "origin/main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 54,
                title: "Reverse merge from main",
                url: "https://github.com/pingdotgg/codething-mvp/pull/54",
                baseRefName: "je-filter-list",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2023-09-28T03:21:10Z",
                updatedAt: "2023-09-28T03:21:10Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/from-main");
      expect(status.pr).toBeNull();
      expect(ghCalls.some((call) => call.includes("pr list"))).toBe(false);
    }),
  );

  it.effect("status finds a PR pushed under the branch's own name despite a default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pushed-plain", "origin/main"]);
      // A plain push (no -u) leaves the upstream on origin/main.
      yield* runGit(repoDir, ["push", "origin", "feature/pushed-plain"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "feature/pushed-plain": JSON.stringify([
              {
                number: 88,
                title: "Pushed without -u",
                url: "https://github.com/pingdotgg/codething-mvp/pull/88",
                baseRefName: "main",
                headRefName: "feature/pushed-plain",
                state: "OPEN",
                updatedAt: "2026-05-01T10:00:00Z",
              },
            ]),
          },
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/pushed-plain");
      expect(status.pr?.number).toBe(88);
      expect(ghCalls.some((call) => call.includes("--head main"))).toBe(false);
    }),
  );

  it.effect(
    "status finds a fork PR pushed under the branch's own name despite a default upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t2code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
        yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
        yield* runGit(repoDir, ["checkout", "-b", "feature/fork-plain", "origin/main"]);
        // Pushed to the fork without -u: upstream stays origin/main.
        yield* runGit(repoDir, ["push", "team/fork", "feature/fork-plain"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "git@github.com:pingdotgg/codething-mvp.git",
          originDir,
        );
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "team/fork",
          "git@github.com:contributor/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "contributor:feature/fork-plain": JSON.stringify([
                {
                  number: 89,
                  title: "Fork PR pushed without -u",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/89",
                  baseRefName: "main",
                  headRefName: "feature/fork-plain",
                  state: "OPEN",
                  updatedAt: "2026-05-01T10:00:00Z",
                  isCrossRepository: true,
                  headRepository: { nameWithOwner: "contributor/codething-mvp" },
                  headRepositoryOwner: { login: "contributor" },
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.pr?.number).toBe(89);
        expect(ghCalls.some((call) => call.includes("--head contributor:feature/fork-plain"))).toBe(
          true,
        );
        expect(ghCalls.some((call) => call.includes("--head main"))).toBe(false);
      }),
  );

  it.effect("branch PR lookup verifies identity on the fork that holds the own-name ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
      yield* runGit(repoDir, ["checkout", "-b", "feature/fork-settle", "origin/main"]);
      yield* runGit(repoDir, ["push", "team/fork", "feature/fork-settle"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "team/fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const { manager } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "contributor:feature/fork-settle": JSON.stringify([
              {
                number: 91,
                title: "Fork PR to settle",
                url: "https://github.com/pingdotgg/codething-mvp/pull/91",
                baseRefName: "main",
                headRefName: "feature/fork-settle",
                state: "MERGED",
                updatedAt: "2026-05-02T10:00:00Z",
                isCrossRepository: true,
                headRepository: { nameWithOwner: "contributor/codething-mvp" },
                headRepositoryOwner: { login: "contributor" },
              },
            ]),
          },
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/fork-settle",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-05-02T10:00:00.000Z",
      });
    }),
  );

  it.effect("status keeps an own-name PR when a later lookup fails on a default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/sticky-plain", "origin/main"]);
      yield* runGit(repoDir, ["push", "origin", "feature/sticky-plain"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "feature/sticky-plain": JSON.stringify([
              {
                number: 90,
                title: "Sticky own-name PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/90",
                baseRefName: "main",
                headRefName: "feature/sticky-plain",
                state: "OPEN",
                updatedAt: "2026-05-01T10:00:00Z",
              },
            ]),
          },
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(90);

      yield* manager.invalidateStatus(repoDir);
      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(90);
    }),
  );

  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 45,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/45",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "MERGED",
                mergedAt: "2026-01-31T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
              },
              {
                number: 46,
                title: "Open PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/46",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "OPEN",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-open-over-merged");
      expect(status.pr).toEqual({
        number: 46,
        title: "Open PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/46",
        baseRef: "main",
        headRef: "feature/status-open-over-merged",
        state: "open",
        updatedAt: "2026-01-30T10:00:00.000Z",
      });
    }),
  );

  it.effect("status is resilient to gh lookup failures and returns pr null", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-no-gh"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-no-gh"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("gh is not available on PATH"),
          }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-no-gh");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("status logs actionable provider detail without exposing the upstream cause", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-rate-limited"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-rate-limited"]);

      const upstreamCause = "GraphQL rate limit for user ID 51714798 and token secret-value";
      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCli.GitHubCliRateLimitError({
            command: "gh",
            cwd: repoDir,
            cause: new Error(upstreamCause),
          }),
        },
      });
      const logs: Array<{ message: string; annotations: Record<string, unknown> }> = [];
      const logger = Logger.make<unknown, void>(({ fiber, message }) => {
        logs.push({
          message: String(message),
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });

      const status = yield* manager
        .status({ cwd: repoDir })
        .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      expect(status.pr).toBeNull();
      const warning = logs.find((entry) => entry.message.includes("PR lookup failed"));
      expect(warning?.annotations).toMatchObject({
        operation: "lookupStatusPr",
        branch: "feature/status-rate-limited",
        errorTag: "SourceControlProviderError",
        provider: "github",
        providerOperation: "listChangeRequests",
        providerCommand: "gh",
        errorDetail:
          "GitHub API rate limit exceeded. Run `gh api rate_limit` to inspect the quota and reset time.",
      });
      const loggedText = [
        warning?.message ?? "",
        ...Object.values(warning?.annotations ?? {}).map(String),
      ].join("\n");
      expect(loggedText).not.toContain(upstreamCause);
      expect(loggedText).not.toContain("secret-value");
    }),
  );

  it.effect("status keeps the last known PR when a later lookup fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-sticky"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-sticky"]);

      const existingPr = {
        number: 214,
        title: "Sticky PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/214",
        baseRefName: "main",
        headRefName: "feature/pr-sticky",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(214);

      // An explicit invalidation (user refresh, git action) bypasses the PR
      // cache and forces a live lookup — which now fails. The badge must keep
      // the last known PR instead of blanking out.
      yield* manager.invalidateStatus(repoDir);
      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(214);
    }),
  );

  it.effect(
    "status does not reuse a stale PR after the branch is retargeted to a different upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t2code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-retarget"]);

        const originRemote = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originRemote]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-retarget"]);

        const existingPr = {
          number: 214,
          title: "Sticky PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/214",
          baseRefName: "main",
          headRefName: "feature/pr-retarget",
        };
        const { manager } = yield* makeManager({
          ghScenario: {
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            prListSequence: [JSON.stringify([existingPr])],
            failWith: new GitHubCli.GitHubCliUnavailableError({
              command: "gh",
              cwd: repoDir,
              cause: new Error("rate limited"),
            }),
            failAfterCalls: 1,
          },
        });

        const first = yield* manager.status({ cwd: repoDir });
        expect(first.pr?.number).toBe(214);

        // Retarget the branch to a different remote/upstream (e.g. the PR was
        // reopened against a fork). The previously cached PR belonged to the
        // old upstream and must not be shown against the new one.
        const forkRemote = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork", forkRemote]);
        yield* runGit(repoDir, ["push", "fork", "feature/pr-retarget"]);
        yield* runGit(repoDir, [
          "branch",
          "--set-upstream-to=fork/feature/pr-retarget",
          "feature/pr-retarget",
        ]);

        yield* manager.invalidateStatus(repoDir);
        const second = yield* manager.status({ cwd: repoDir });
        expect(second.pr).toBeNull();
      }),
  );

  it.effect("status keeps the last known PR when the branch gains its first upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-sticky-first-push"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);

      const existingPr = {
        number: 215,
        title: "Sticky first-push PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/215",
        baseRefName: "main",
        headRefName: "feature/pr-sticky-first-push",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(215);

      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-sticky-first-push"]);
      yield* manager.invalidateStatus(repoDir);

      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(215);
    }),
  );

  it.effect("status drops the last known PR when the tracked remote is repointed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-repointed"]);
      const originalRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originalRemoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-repointed"]);

      const existingPr = {
        number: 216,
        title: "Old remote PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/216",
        baseRefName: "main",
        headRefName: "feature/pr-repointed",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(216);

      const replacementRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "replacement", replacementRemoteDir]);
      yield* runGit(repoDir, ["push", "replacement", "feature/pr-repointed"]);
      yield* runGit(repoDir, ["remote", "set-url", "origin", replacementRemoteDir]);
      yield* manager.invalidateStatus(repoDir);

      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr).toBeNull();
    }),
  );

  it.effect("status keeps the last known PR when the current remote URL can't be resolved", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-config-hiccup"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-config-hiccup"]);

      const existingPr = {
        number: 217,
        title: "Config hiccup PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/217",
        baseRefName: "main",
        headRefName: "feature/pr-config-hiccup",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(217);

      // `remote.origin.url` reads go through readConfigValueNullable, which
      // maps ANY failed read (a real "no remote configured" state or a
      // transient git-config hiccup) to null the same way. Unsetting the
      // key here reproduces that ambiguity without touching branch
      // tracking (refs/remotes/origin/* and branch.<b>.remote are
      // untouched) — the remote identity has not actually changed, so the
      // sticky PR must survive even though the current lookup can no
      // longer resolve a remote URL to compare against.
      yield* runGit(repoDir, ["config", "--unset", "remote.origin.url"]);
      yield* manager.invalidateStatus(repoDir);

      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(217);
    }),
  );

  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Use a direct tone.",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Implement stacked git actions", body: "" });
          },
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(generatedPolicy).toMatchObject({ commitInstructions: "Use a direct tone." });
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Push",
          action: {
            kind: "push",
          },
        },
      });
      expect(result.toast.title).toMatch(/^Committed [0-9a-f]{7}$/);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("Implement stacked git actions");
    }),
  );

  it.effect("preserves custom style when instructions are empty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Preserve custom style", body: "" });
          },
        },
      });
      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedPolicy).toEqual({
        kind: "custom",
        inferRepositoryConventions: false,
      });
    }),
  );

  it.effect("falls back when the dedicated source control writer is unavailable", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      const missingInstanceId = ProviderInstanceId.make("missing_writer");
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          providerInstances: {
            [missingInstanceId]: {
              driver: ProviderDriverKind.make("missing-driver"),
              config: {},
            },
          },
          sourceControlWriterModelSelection: {
            instanceId: missingInstanceId,
            model: "missing-model",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the available writer", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedModelSelection).toEqual(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
    }),
  );

  it.effect("includes local agent instructions when recent history is empty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* runGit(repoDir, ["init", "--initial-branch=main"]);
      yield* runGit(repoDir, ["config", "user.email", "test@example.com"]);
      yield* runGit(repoDir, ["config", "user.name", "Test User"]);
      const agentInstructions = "Use lowercase source control text.";
      const claudeInstructions = "Keep pull request bodies brief.";
      NodeFS.writeFileSync(NodePath.join(repoDir, "AGENTS.md"), agentInstructions);
      NodeFS.writeFileSync(NodePath.join(repoDir, "CLAUDE.md"), claudeInstructions);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\n");
      yield* runGit(repoDir, ["add", "README.md"]);
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          textGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
          sourceControlWritingStyle: {
            mode: "repo_conventions" as const,
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Create initial commit", body: "" });
          },
        },
      });
      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedPolicy).toEqual({
        kind: "repo_conventions",
        commitInstructions: `Follow the repository's established commit message style when examples are available.\n\nLocal AGENTS.md:\n${agentInstructions}\n\nLocal CLAUDE.md:\n${claudeInstructions}`,
        changeRequestInstructions: `Follow the repository's established change request title and body style when examples are available.\n\nLocal AGENTS.md:\n${agentInstructions}\n\nLocal CLAUDE.md:\n${claudeInstructions}`,
        inferRepositoryConventions: true,
      });
    }),
  );

  it.effect("uses custom commit message when provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\ncustom\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "this should not be used",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feat: custom summary line");
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%b"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toContain("- details from user");
    }),
  );

  it.effect("commits only selected files when filePaths is provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "a.txt"), "file a\n");
      NodeFS.writeFileSync(NodePath.join(repoDir, "b.txt"), "file b\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        filePaths: ["a.txt"],
      });

      expect(result.commit.status).toBe("created");

      // b.txt should remain in the working tree
      const statusStdout = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
        Effect.map((r) => r.stdout),
      );
      expect(statusStdout).toContain("b.txt");
      expect(statusStdout).not.toContain("a.txt");
    }),
  );

  it.effect("creates feature branch, commits, and pushes with featureBranch option", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nfeature-branch\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "Implement stacked git actions",
                body: "",
                ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/implement-stacked-git-actions");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      });
      expect(result.toast.title).toMatch(
        /^Pushed [0-9a-f]{7} to origin\/feature\/implement-stacked-git-actions$/,
      );
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feature/implement-stacked-git-actions");

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
      expect(generatedCount).toBe(1);
    }),
  );

  it.effect("featureBranch uses custom commit message and derives branch name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t2code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\ncustom-feature\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "unused",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/feat-custom-summary-line");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", result.branch.name!]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
    }),
  );
});
