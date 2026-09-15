import { describe, expect, it } from "vite-plus/test";

import { createNpmPublishInvocation } from "./npmPublish.ts";

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
