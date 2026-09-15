import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  createNpmPublishInvocation,
  createNpmPublishPlan,
  NpmPackageIntegrityError,
  parseNpmPackageMetadata,
  runNpmPublishPlan,
  type NpmPublishPlanStep,
  waitForNpmPackageVisibility,
  waitForNpmPackagesVisibility,
} from "./npmPublish.ts";

const packageName = "@t2code/t2-linux-x64";
const packageVersion = "0.0.41-nightly.20260915.1";
const tarballUrl =
  "https://registry.npmjs.org/@t2code/t2-linux-x64/-/t2-linux-x64-0.0.41-nightly.20260915.1.tgz";

const tarballIntegrity = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

const registryMetadata = (integrity: string) => ({
  name: packageName,
  versions: {
    [packageVersion]: {
      name: packageName,
      version: packageVersion,
      dist: { tarball: tarballUrl, integrity },
    },
  },
});

describe("createNpmPublishInvocation", () => {
  it("passes an OTP to npm while redacting it from verbose logs", () => {
    const invocation = createNpmPublishInvocation({
      access: "public",
      tag: "preview",
      provenance: false,
      dryRun: false,
      otp: "123456",
      interactive: true,
      verbose: false,
    });

    expect(invocation.args).toEqual([
      "publish",
      "--access",
      "public",
      "--tag",
      "preview",
      "--otp",
      "123456",
    ]);
    expect(invocation.logArgs).toEqual([
      "publish",
      "--access",
      "public",
      "--tag",
      "preview",
      "--otp",
      "<redacted>",
    ]);
    expect(invocation.errorArgs).toEqual(invocation.logArgs);
    expect(invocation.errorArgs).not.toContain("123456");
    expect(invocation.stdin).toBe("inherit");
    expect(invocation.stdout).toBe("inherit");
    expect(invocation.stderr).toBe("inherit");
  });

  it("keeps CI dry runs noninteractive and preserves provenance flags", () => {
    const invocation = createNpmPublishInvocation({
      access: "public",
      tag: "latest",
      provenance: true,
      dryRun: true,
      interactive: false,
      verbose: false,
    });

    expect(invocation.args).toEqual([
      "publish",
      "--access",
      "public",
      "--tag",
      "latest",
      "--provenance",
      "--dry-run",
    ]);
    expect(invocation.logArgs).toEqual(invocation.args);
    expect(invocation.stdin).toBe("ignore");
    expect(invocation.stdout).toBe("ignore");
    expect(invocation.stderr).toBe("inherit");
  });
});

describe("parseNpmPackageMetadata", () => {
  it("uses the package version embedded in generated package metadata", () => {
    expect(
      parseNpmPackageMetadata(
        JSON.stringify({ name: packageName, version: packageVersion }),
        "t2-linux-x64/package.json",
      ),
    ).toEqual({ name: packageName, version: packageVersion });
  });

  it("rejects metadata without a package identity", () => {
    expect(() => parseNpmPackageMetadata(JSON.stringify({ name: packageName }))).toThrow(
      "has no version",
    );
  });
});

describe("waitForNpmPackageVisibility", () => {
  it("retries public metadata until the exact tarball is available and streams its integrity", async () => {
    const tarball = new TextEncoder().encode("platform package tarball");
    const requests: Array<{ readonly url: string; readonly accept: string | null }> = [];
    const delays: Array<number> = [];
    let metadataRequests = 0;
    let now = 0;

    const result = await waitForNpmPackageVisibility(
      { name: packageName, version: packageVersion, integrity: tarballIntegrity(tarball) },
      {
        registryUrl: "https://registry.example.test",
        timeoutMs: 100,
        retryDelayMs: 10,
        maxRetryDelayMs: 20,
        now: () => now,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
          now += milliseconds;
        },
        fetch: async (url, init) => {
          requests.push({
            url,
            accept: new Headers(init?.headers).get("accept"),
          });
          if (url.includes("%2F") && metadataRequests++ === 0) {
            return new Response("not ready", { status: 404 });
          }
          if (url.includes("%2F")) {
            return new Response(JSON.stringify(registryMetadata(tarballIntegrity(tarball))), {
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(tarball.slice(0, 8));
                controller.enqueue(tarball.slice(8));
                controller.close();
              },
            }),
          );
        },
      },
    );

    expect(result).toEqual({ name: packageName, version: packageVersion, tarballUrl });
    expect(delays).toEqual([10]);
    expect(requests).toEqual([
      {
        url: "https://registry.example.test/@t2code%2Ft2-linux-x64",
        accept: "application/vnd.npm.install-v1+json",
      },
      {
        url: "https://registry.example.test/@t2code%2Ft2-linux-x64",
        accept: "application/vnd.npm.install-v1+json",
      },
      { url: tarballUrl, accept: "application/octet-stream" },
    ]);
  });

  it("fails closed when the public tarball does not match registry integrity", async () => {
    const tarball = new TextEncoder().encode("wrong bytes");
    const expected = new TextEncoder().encode("published bytes");
    let tarballRequested = false;

    const pending = waitForNpmPackageVisibility(
      { name: packageName, version: packageVersion },
      {
        fetch: async (url) => {
          if (url.includes("%2F")) {
            return new Response(JSON.stringify(registryMetadata(tarballIntegrity(expected))));
          }
          tarballRequested = true;
          return new Response(tarball);
        },
      },
    );

    await expect(pending).rejects.toBeInstanceOf(NpmPackageIntegrityError);
    expect(tarballRequested).toBe(true);
  });

  it("fails before downloading when registry integrity differs from the local tarball", async () => {
    const local = new TextEncoder().encode("local package tarball");
    const remote = new TextEncoder().encode("different published tarball");
    let tarballRequested = false;

    const pending = waitForNpmPackageVisibility(
      { name: packageName, version: packageVersion, integrity: tarballIntegrity(local) },
      {
        fetch: async (url) => {
          if (url.includes("%2F")) {
            return new Response(JSON.stringify(registryMetadata(tarballIntegrity(remote))));
          }
          tarballRequested = true;
          return new Response(remote);
        },
      },
    );

    await expect(pending).rejects.toBeInstanceOf(NpmPackageIntegrityError);
    expect(tarballRequested).toBe(false);
  });

  it("falls back to the full registry document when abbreviated metadata is unavailable", async () => {
    const tarball = new TextEncoder().encode("platform package tarball");
    const accepts: Array<string | null> = [];
    let metadataRequests = 0;

    const result = await waitForNpmPackageVisibility(
      { name: packageName, version: packageVersion },
      {
        fetch: async (url, init) => {
          accepts.push(new Headers(init?.headers).get("accept"));
          if (url.includes("%2F")) {
            metadataRequests += 1;
            if (metadataRequests === 1) {
              return new Response(JSON.stringify({ name: packageName }));
            }
            return new Response(JSON.stringify(registryMetadata(tarballIntegrity(tarball))));
          }
          return new Response(tarball);
        },
      },
    );

    expect(result.version).toBe(packageVersion);
    expect(accepts).toEqual([
      "application/vnd.npm.install-v1+json",
      "application/json",
      "application/octet-stream",
    ]);
  });

  it("times out without exposing a missing version as ready", async () => {
    let now = 0;
    let requests = 0;
    const pending = waitForNpmPackageVisibility(
      { name: packageName, version: packageVersion },
      {
        timeoutMs: 20,
        retryDelayMs: 10,
        maxRetryDelayMs: 10,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        fetch: async () => {
          requests += 1;
          return new Response("not ready", { status: 404 });
        },
      },
    );

    await expect(pending).rejects.toThrow(/Timed out waiting for public npm package/);
    expect(requests).toBe(2);
  });

  it("uses one deadline for a concurrent platform visibility phase", async () => {
    const tarball = new TextEncoder().encode("platform package tarball");
    const metadata = [
      { name: packageName, version: packageVersion },
      { name: "@t2code/t2-win32-x64", version: packageVersion },
    ] as const;
    let now = 0;
    let metadataRequests = 0;

    const pending = waitForNpmPackagesVisibility(metadata, {
      timeoutMs: 20,
      retryDelayMs: 10,
      maxRetryDelayMs: 10,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      fetch: async (url) => {
        if (url.includes("%2F")) {
          metadataRequests += 1;
          return new Response("not ready", { status: 404 });
        }
        return new Response(tarball);
      },
    });

    await expect(pending).rejects.toThrow(/Timed out waiting for public npm package/);
    // Both package checks share the same fake clock/deadline rather than
    // taking two serial timeout windows.
    expect(metadataRequests).toBeGreaterThanOrEqual(2);
    expect(now).toBe(20);
  });

  it("aborts a hung registry request at the remaining phase deadline", async () => {
    let aborted = false;
    const pending = waitForNpmPackageVisibility(
      { name: packageName, version: packageVersion },
      {
        timeoutMs: 10,
        requestTimeoutMs: 1,
        sleep: async () => {},
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal === undefined || signal === null) {
              reject(new Error("request signal missing"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("request aborted"));
              },
              { once: true },
            );
          }),
      },
    );

    await expect(pending).rejects.toThrow(/Timed out waiting for public npm package/);
    expect(aborted).toBe(true);
  });
});

const publishPlanFixture = () => {
  const platformPackages = [
    {
      tarball: "t2-linux-x64.tgz",
      packageMetadata: {
        name: "@t2code/t2-linux-x64",
        version: packageVersion,
        optionalDependencies: {},
        integrity: "sha512-platform-linux",
      },
    },
    {
      tarball: "t2-win32-x64.tgz",
      packageMetadata: {
        name: "@t2code/t2-win32-x64",
        version: packageVersion,
        optionalDependencies: {},
        integrity: "sha512-platform-windows",
      },
    },
  ] as const;
  const launcherPackage = {
    tarball: "cli.tgz",
    packageMetadata: {
      name: "@t2code/cli",
      version: packageVersion,
      optionalDependencies: {
        "@t2code/t2-linux-x64": packageVersion,
        "@t2code/t2-win32-x64": packageVersion,
      },
      integrity: "sha512-launcher",
    },
  } as const;
  return { platformPackages, launcherPackage };
};

const planStepLabel = (step: NpmPublishPlanStep): string => {
  switch (step._tag) {
    case "publish":
      return `publish:${step.artifact.tarball}`;
    case "wait-for-platforms":
      return "wait-for-platforms";
    case "wait-for-launcher":
      return "wait-for-launcher";
  }
};

describe("runNpmPublishPlan", () => {
  it("runs platform publishes, one shared platform gate, launcher publish, and launcher gate in order", async () => {
    const { platformPackages, launcherPackage } = publishPlanFixture();
    const events: Array<string> = [];

    await Effect.runPromise(
      runNpmPublishPlan(createNpmPublishPlan(platformPackages, launcherPackage, true), (step) =>
        Effect.sync(() => events.push(planStepLabel(step))),
      ),
    );

    expect(events).toEqual([
      "publish:t2-linux-x64.tgz",
      "publish:t2-win32-x64.tgz",
      "wait-for-platforms",
      "publish:cli.tgz",
      "wait-for-launcher",
    ]);
  });

  it("stops before launcher publication when the shared platform gate fails", async () => {
    const { platformPackages, launcherPackage } = publishPlanFixture();
    const events: Array<string> = [];
    const gateFailure = new Error("platform package is not publicly installable");

    await expect(
      Effect.runPromise(
        runNpmPublishPlan(createNpmPublishPlan(platformPackages, launcherPackage, true), (step) =>
          Effect.gen(function* () {
            events.push(planStepLabel(step));
            if (step._tag === "wait-for-platforms") {
              return yield* Effect.fail(gateFailure);
            }
          }),
        ),
      ),
    ).rejects.toBe(gateFailure);

    expect(events).toEqual([
      "publish:t2-linux-x64.tgz",
      "publish:t2-win32-x64.tgz",
      "wait-for-platforms",
    ]);
  });

  it("does not add visibility gates to a dry-run plan", async () => {
    const { platformPackages, launcherPackage } = publishPlanFixture();
    const events: Array<string> = [];

    await Effect.runPromise(
      runNpmPublishPlan(createNpmPublishPlan(platformPackages, launcherPackage, false), (step) =>
        Effect.sync(() => events.push(planStepLabel(step))),
      ),
    );

    expect(events).toEqual([
      "publish:t2-linux-x64.tgz",
      "publish:t2-win32-x64.tgz",
      "publish:cli.tgz",
    ]);
  });

  it("runs the launcher gate after launcher publication and propagates its failure", async () => {
    const { platformPackages, launcherPackage } = publishPlanFixture();
    const events: Array<string> = [];
    const gateFailure = new Error("launcher is not publicly installable");

    await expect(
      Effect.runPromise(
        runNpmPublishPlan(createNpmPublishPlan(platformPackages, launcherPackage, true), (step) =>
          Effect.gen(function* () {
            events.push(planStepLabel(step));
            if (step._tag === "wait-for-launcher") {
              return yield* Effect.fail(gateFailure);
            }
          }),
        ),
      ),
    ).rejects.toBe(gateFailure);

    expect(events).toEqual([
      "publish:t2-linux-x64.tgz",
      "publish:t2-win32-x64.tgz",
      "wait-for-platforms",
      "publish:cli.tgz",
      "wait-for-launcher",
    ]);
  });
});
