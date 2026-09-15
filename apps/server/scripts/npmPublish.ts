// @effect-diagnostics nodeBuiltinImport:off - npm publish probes run on plain Node streams and fetch APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeTimersPromises from "node:timers/promises";
import * as Effect from "effect/Effect";

const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";

/** npm can accept a publish before its package metadata and tarball are public. */
const DEFAULT_NPM_VISIBILITY_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_NPM_VISIBILITY_RETRY_DELAY_MS = 5 * 1000;
const DEFAULT_NPM_VISIBILITY_MAX_RETRY_DELAY_MS = 30 * 1000;
const NPM_VISIBILITY_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export interface NpmPackageMetadata {
  readonly name: string;
  readonly version: string;
  /** Integrity of the local tgz, when available during a release publish. */
  readonly integrity?: string;
}

export interface NpmPackageManifest extends NpmPackageMetadata {
  readonly optionalDependencies: Readonly<Record<string, string>>;
}

export interface NpmPackageArtifactMetadata extends NpmPackageManifest {
  readonly integrity: string;
}

export interface NpmPublishArtifact {
  readonly tarball: string;
  readonly packageMetadata: NpmPackageArtifactMetadata;
}

export type NpmPublishPlanStep =
  | {
      readonly _tag: "publish";
      readonly artifact: NpmPublishArtifact;
    }
  | {
      readonly _tag: "wait-for-platforms";
      readonly packages: ReadonlyArray<NpmPackageArtifactMetadata>;
    }
  | {
      readonly _tag: "wait-for-launcher";
      readonly packageMetadata: NpmPackageArtifactMetadata;
    };

/**
 * Builds the ordered publication phases. Keeping the gate steps in the plan
 * makes it impossible for the command to accidentally publish the launcher
 * before the platform gate, or to skip the launcher gate after publishing it.
 */
export function createNpmPublishPlan(
  platformPackages: ReadonlyArray<NpmPublishArtifact>,
  launcherPackage: NpmPublishArtifact,
  waitForVisibility: boolean,
): ReadonlyArray<NpmPublishPlanStep> {
  const steps: Array<NpmPublishPlanStep> = platformPackages.map((artifact) => ({
    _tag: "publish",
    artifact,
  }));
  if (waitForVisibility) {
    steps.push({
      _tag: "wait-for-platforms",
      packages: platformPackages.map(({ packageMetadata }) => packageMetadata),
    });
  }
  steps.push({ _tag: "publish", artifact: launcherPackage });
  if (waitForVisibility) {
    steps.push({ _tag: "wait-for-launcher", packageMetadata: launcherPackage.packageMetadata });
  }
  return steps;
}

/** Executes the plan sequentially; a failed gate prevents all later steps. */
export const runNpmPublishPlan = Effect.fn("runNpmPublishPlan")(function* <E, R>(
  plan: ReadonlyArray<NpmPublishPlanStep>,
  runStep: (step: NpmPublishPlanStep) => Effect.Effect<void, E, R>,
): Effect.fn.Return<void, E, R> {
  for (const step of plan) {
    yield* runStep(step);
  }
});

export interface NpmPackageVisibility {
  readonly name: string;
  readonly version: string;
  readonly tarballUrl: string;
}

export interface NpmPackageVisibilityOptions {
  /** Public registry base URL. Kept injectable for deterministic tests. */
  readonly registryUrl?: string;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly requestTimeoutMs?: number;
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

class NpmPackageVisibilityError extends Error {
  readonly packageName: string;
  readonly version: string;
  readonly attempts: number;
  readonly reason: string;

  constructor(input: {
    readonly packageName: string;
    readonly version: string;
    readonly attempts: number;
    readonly reason: string;
  }) {
    super(
      `Timed out waiting for public npm package ${input.packageName}@${input.version} after ${input.attempts} checks (${input.reason}).`,
    );
    this.name = "NpmPackageVisibilityError";
    this.packageName = input.packageName;
    this.version = input.version;
    this.attempts = input.attempts;
    this.reason = input.reason;
  }
}

export class NpmPackageIntegrityError extends Error {
  readonly packageName: string;
  readonly version: string;
  readonly expectedIntegrity: string;
  readonly actualIntegrity: string;

  constructor(input: {
    readonly packageName: string;
    readonly version: string;
    readonly expectedIntegrity: string;
    readonly actualIntegrity: string;
  }) {
    super(
      `Public npm tarball for ${input.packageName}@${input.version} failed integrity verification.`,
    );
    this.name = "NpmPackageIntegrityError";
    this.packageName = input.packageName;
    this.version = input.version;
    this.expectedIntegrity = input.expectedIntegrity;
    this.actualIntegrity = input.actualIntegrity;
  }
}

/**
 * Reads the package identity from the generated package metadata. The release
 * tag is deliberately not involved: npm publish must be gated on the exact
 * version carried by the tarball's package.json.
 */
export function parseNpmPackageMetadata(json: string, source = "package.json"): NpmPackageMetadata {
  const manifest = parseNpmPackageManifest(json, source);
  return { name: manifest.name, version: manifest.version };
}

export function parseNpmPackageManifest(json: string, source = "package.json"): NpmPackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error(`Invalid npm package metadata at ${source}.`);
  }

  if (value === null || typeof value !== "object") {
    throw new Error(`Invalid npm package metadata at ${source}.`);
  }

  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) {
    throw new Error(`npm package metadata at ${source} has no name.`);
  }
  if (typeof record.version !== "string" || record.version.length === 0) {
    throw new Error(`npm package metadata at ${source} has no version.`);
  }

  const optionalDependenciesValue = record.optionalDependencies;
  if (optionalDependenciesValue === undefined) {
    return { name: record.name, version: record.version, optionalDependencies: {} };
  }
  if (!isRecord(optionalDependenciesValue)) {
    throw new Error(`npm package metadata at ${source} has invalid optionalDependencies.`);
  }
  const optionalDependencies: Record<string, string> = {};
  for (const [dependencyName, dependencyVersion] of Object.entries(optionalDependenciesValue)) {
    if (typeof dependencyVersion !== "string" || dependencyVersion.length === 0) {
      throw new Error(`npm package metadata at ${source} has invalid optionalDependencies.`);
    }
    optionalDependencies[dependencyName] = dependencyVersion;
  }

  return { name: record.name, version: record.version, optionalDependencies };
}

interface NpmRegistryVersionMetadata {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dist?: {
    readonly tarball?: unknown;
    readonly integrity?: unknown;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const encodeNpmPackageName = (name: string): string =>
  encodeURIComponent(name).replace(/^%40/, "@");

const publicRegistryPackageUrl = (registryUrl: string, name: string): string =>
  `${registryUrl.replace(/\/+$/, "")}/${encodeNpmPackageName(name)}`;

const responseStatus = (response: Response): string => `HTTP ${response.status}`;

const responseJson = async (response: Response): Promise<unknown> => response.json();

const registryRequestInit = (accept: string, timeoutMs: number): RequestInit => ({
  headers: { accept },
  credentials: "omit",
  signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
});

const readSha512Integrity = (integrity: unknown): string | undefined => {
  if (typeof integrity !== "string") return undefined;
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  return match?.[1];
};

/** Hashes a response body without retaining the (potentially very large) tarball. */
const streamSha512 = async (response: Response): Promise<string> => {
  if (response.body === null) {
    throw new Error("tarball response has no body");
  }

  const hash = NodeCrypto.createHash("sha512");
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("base64");
};

/** Hashes a local package tarball without retaining its bytes in memory. */
export async function sha512File(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha512");
  for await (const chunk of NodeFS.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `sha512-${hash.digest("base64")}`;
}

type VisibilityProbeResult =
  | { readonly ready: true; readonly tarballUrl: string }
  | { readonly ready: false; readonly reason: string };

type RegistryDocumentResult =
  | { readonly ok: true; readonly document: unknown }
  | { readonly ok: false; readonly reason: string };

const fetchRegistryDocument = async (
  url: string,
  accept: string,
  timeoutMs: number,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<RegistryDocumentResult> => {
  let response: Response;
  try {
    response = await fetcher(url, registryRequestInit(accept, timeoutMs));
  } catch {
    return { ok: false, reason: "registry metadata request failed" };
  }
  if (!response.ok) {
    return { ok: false, reason: `registry metadata ${responseStatus(response)}` };
  }
  try {
    return { ok: true, document: await responseJson(response) };
  } catch {
    return { ok: false, reason: "registry metadata was not valid JSON" };
  }
};

const probeNpmPackageVisibility = async (
  metadata: NpmPackageMetadata,
  registryUrl: string,
  requestTimeoutMs: () => number,
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<VisibilityProbeResult> => {
  const metadataUrl = publicRegistryPackageUrl(registryUrl, metadata.name);
  let documentResult = await fetchRegistryDocument(
    metadataUrl,
    "application/vnd.npm.install-v1+json",
    requestTimeoutMs(),
    fetcher,
  );
  // npm install uses the abbreviated representation. A small number of
  // registry proxies omit that representation; only then fall back to the
  // full document, while keeping the normal probe identical to npm install.
  if (
    documentResult.ok &&
    !(isRecord(documentResult.document) && isRecord(documentResult.document.versions))
  ) {
    documentResult = await fetchRegistryDocument(
      metadataUrl,
      "application/json",
      requestTimeoutMs(),
      fetcher,
    );
  }
  if (!documentResult.ok) {
    return { ready: false, reason: documentResult.reason };
  }

  const document = documentResult.document;
  if (!isRecord(document) || document.name !== metadata.name) {
    return { ready: false, reason: "registry metadata has the wrong package name" };
  }
  const versions =
    isRecord(document) && isRecord(document.versions) ? document.versions : undefined;
  const versionMetadataValue = versions?.[metadata.version];
  const versionMetadata = isRecord(versionMetadataValue)
    ? (versionMetadataValue as NpmRegistryVersionMetadata)
    : undefined;
  if (
    versionMetadata === undefined ||
    versionMetadata.name !== metadata.name ||
    versionMetadata.version !== metadata.version
  ) {
    return { ready: false, reason: "exact package version is not in registry metadata" };
  }

  const dist = isRecord(versionMetadata.dist) ? versionMetadata.dist : undefined;
  const tarballUrl = dist?.tarball;
  const expectedIntegrity = dist?.integrity;
  const expectedDigest = readSha512Integrity(expectedIntegrity);
  if (typeof tarballUrl !== "string" || expectedDigest === undefined) {
    return { ready: false, reason: "registry metadata has no usable tarball integrity" };
  }
  const registryIntegrity = `sha512-${expectedDigest}`;
  if (metadata.integrity !== undefined && metadata.integrity !== registryIntegrity) {
    throw new NpmPackageIntegrityError({
      packageName: metadata.name,
      version: metadata.version,
      expectedIntegrity: metadata.integrity,
      actualIntegrity: registryIntegrity,
    });
  }

  let tarballResponse: Response;
  try {
    // This is intentionally a fresh unauthenticated request to the tarball URL
    // from the public registry metadata, matching what npm install consumes.
    tarballResponse = await fetcher(
      tarballUrl,
      registryRequestInit("application/octet-stream", requestTimeoutMs()),
    );
  } catch {
    return { ready: false, reason: "public tarball request failed" };
  }

  if (!tarballResponse.ok) {
    return { ready: false, reason: `public tarball ${responseStatus(tarballResponse)}` };
  }

  let actualDigest: string;
  try {
    actualDigest = await streamSha512(tarballResponse);
  } catch {
    return { ready: false, reason: "public tarball could not be read" };
  }
  const actualIntegrity = `sha512-${actualDigest}`;
  if (actualDigest !== expectedDigest) {
    throw new NpmPackageIntegrityError({
      packageName: metadata.name,
      version: metadata.version,
      expectedIntegrity: `sha512-${expectedDigest}`,
      actualIntegrity,
    });
  }

  return { ready: true, tarballUrl };
};

/**
 * Waits until npm's public, unauthenticated install view exposes one exact
 * package version and a readable, integrity-matching tarball. npm can accept a
 * publish before its CDN/index has finished processing, so callers should run
 * this between platform packages and the launcher.
 */
interface NpmPackageVisibilityWaitConfig {
  readonly registryUrl: string;
  readonly retryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly requestTimeoutMs: number;
  readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

const resolveVisibilityWaitConfig = (
  options: NpmPackageVisibilityOptions,
): NpmPackageVisibilityWaitConfig & { readonly timeoutMs: number } => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NPM_VISIBILITY_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_NPM_VISIBILITY_RETRY_DELAY_MS;
  const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_NPM_VISIBILITY_MAX_RETRY_DELAY_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? NPM_VISIBILITY_REQUEST_TIMEOUT_MS;
  const registryUrl = options.registryUrl ?? DEFAULT_NPM_REGISTRY_URL;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep =
    options.sleep ??
    ((milliseconds: number) => NodeTimersPromises.setTimeout(milliseconds).then(() => undefined));
  const now = options.now ?? Date.now;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("npm package visibility timeout must be positive");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("npm package visibility retry delay must be non-negative");
  }
  if (!Number.isFinite(maxRetryDelayMs) || maxRetryDelayMs < 0) {
    throw new Error("npm package visibility maximum retry delay must be non-negative");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error("npm package visibility request timeout must be positive");
  }

  return {
    timeoutMs,
    registryUrl,
    retryDelayMs,
    maxRetryDelayMs,
    requestTimeoutMs,
    fetcher,
    sleep,
    now,
  };
};

const waitForNpmPackageVisibilityUntil = async (
  metadata: NpmPackageMetadata,
  config: NpmPackageVisibilityWaitConfig,
  deadline: number,
): Promise<NpmPackageVisibility> => {
  let attempts = 0;
  let lastReason = "registry metadata is not available";

  while (true) {
    attempts += 1;
    const remainingBeforeProbeMs = deadline - config.now();
    if (remainingBeforeProbeMs <= 0) {
      throw new NpmPackageVisibilityError({
        packageName: metadata.name,
        version: metadata.version,
        attempts,
        reason: lastReason,
      });
    }
    const result = await probeNpmPackageVisibility(
      metadata,
      config.registryUrl,
      () => Math.min(config.requestTimeoutMs, Math.max(1, deadline - config.now())),
      config.fetcher,
    );
    if (result.ready) {
      return {
        name: metadata.name,
        version: metadata.version,
        tarballUrl: result.tarballUrl,
      };
    }
    lastReason = result.reason;

    const remainingMs = deadline - config.now();
    if (remainingMs <= 0) {
      throw new NpmPackageVisibilityError({
        packageName: metadata.name,
        version: metadata.version,
        attempts,
        reason: lastReason,
      });
    }

    const delay = Math.min(
      config.retryDelayMs * 2 ** Math.min(attempts - 1, 8),
      config.maxRetryDelayMs,
      remainingMs,
    );
    await config.sleep(delay);
  }
};

/** Waits for a group with one shared deadline, so five platform gates cost one phase. */
export async function waitForNpmPackagesVisibility(
  metadata: ReadonlyArray<NpmPackageMetadata>,
  options: NpmPackageVisibilityOptions = {},
): Promise<ReadonlyArray<NpmPackageVisibility>> {
  const config = resolveVisibilityWaitConfig(options);
  const deadline = config.now() + config.timeoutMs;
  return Promise.all(
    metadata.map((packageMetadata) =>
      waitForNpmPackageVisibilityUntil(packageMetadata, config, deadline),
    ),
  );
}

export async function waitForNpmPackageVisibility(
  metadata: NpmPackageMetadata,
  options: NpmPackageVisibilityOptions = {},
): Promise<NpmPackageVisibility> {
  const [visible] = await waitForNpmPackagesVisibility([metadata], options);
  // The input always has one item; keeping this guard makes the function's
  // contract explicit without weakening the array helper's type.
  if (visible === undefined) {
    throw new Error("npm package visibility check received no package metadata");
  }
  return visible;
}

export interface NpmPublishInvocationOptions {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
  readonly otp?: string | undefined;
  readonly interactive: boolean;
  readonly verbose: boolean;
}

export interface NpmPublishInvocation {
  readonly args: ReadonlyArray<string>;
  readonly logArgs: ReadonlyArray<string>;
  readonly errorArgs: ReadonlyArray<string>;
  readonly stdin: "inherit" | "ignore";
  readonly stdout: "inherit" | "ignore";
  readonly stderr: "inherit";
}

/**
 * Builds one npm publish invocation. The command-line OTP is passed to npm,
 * while the copies used for logs and command errors replace it so verbose local
 * publishing cannot disclose the one-time credential.
 */
export function createNpmPublishInvocation(
  options: NpmPublishInvocationOptions,
): NpmPublishInvocation {
  const args = ["publish", "--access", options.access, "--tag", options.tag];
  const logArgs = [...args];

  if (options.provenance) {
    args.push("--provenance");
    logArgs.push("--provenance");
  }
  if (options.dryRun) {
    args.push("--dry-run");
    logArgs.push("--dry-run");
  }
  if (options.otp !== undefined) {
    args.push("--otp", options.otp);
    logArgs.push("--otp", "<redacted>");
  }

  return {
    args,
    logArgs,
    errorArgs: logArgs,
    stdin: options.interactive ? "inherit" : "ignore",
    stdout: options.interactive || options.verbose ? "inherit" : "ignore",
    stderr: "inherit",
  };
}
