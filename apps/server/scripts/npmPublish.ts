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
