import { assert, it } from "@effect/vitest";

import { formatCliCommand } from "./invocation.ts";

it("formats package runner commands from their cache entry paths", () => {
  for (const [entryPath, expected] of [
    ["/home/theo/.npm/_npx/abc123/node_modules/@t2code/cli/dist/bin.mjs", "npx @t2code/cli serve"],
    [
      "C:\\Users\\theo\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@t2code\\cli\\dist\\bin.mjs",
      "npx @t2code/cli serve",
    ],
    [
      "/home/theo/.cache/pnpm/dlx/abc/node_modules/@t2code/cli/dist/bin.mjs",
      "pnpm dlx @t2code/cli serve",
    ],
    [
      "/home/theo/.local/share/pnpm/.pnpm/dlx/abc/node_modules/@t2code/cli/dist/bin.mjs",
      "pnpm dlx @t2code/cli serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\pnpm-cache\\dlx\\abc\\node_modules\\@t2code\\cli\\dist\\bin.mjs",
      "pnpm dlx @t2code/cli serve",
    ],
    ["/home/theo/.bun/install/cache/@t2code/cli@0.0.31/dist/bin.mjs", "bunx @t2code/cli serve"],
    [
      "/tmp/bunx-1000-@t2code-cli@latest/node_modules/@t2code/cli/dist/bin.mjs",
      "bunx @t2code/cli serve",
    ],
    [
      "C:\\Users\\theo\\AppData\\Local\\Temp\\bunx-0-@t2code-cli@latest\\node_modules\\@t2code\\cli\\dist\\bin.mjs",
      "bunx @t2code/cli serve",
    ],
  ] as const) {
    assert.equal(formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }), expected);
  }
});

it("treats stable installs as direct invocations", () => {
  for (const entryPath of [
    "/usr/local/lib/node_modules/@t2code/cli/dist/bin.mjs",
    "/home/theo/Code/work/t3code/apps/server/dist/bin.mjs",
    "/home/theo/.t3/runtime/0.0.31/node_modules/@t2code/cli/dist/bin.mjs",
    "",
  ]) {
    assert.equal(
      formatCliCommand({ subcommand: "serve", entryPath, version: "0.0.31" }),
      "t2code serve",
    );
  }
});

it("re-suggests the nightly channel only for nightly builds", () => {
  for (const [version, expected] of [
    ["0.0.31-nightly.20260729", "npx @t2code/cli@nightly serve"],
    ["0.0.31", "npx @t2code/cli serve"],
  ] as const) {
    assert.equal(
      formatCliCommand({
        subcommand: "serve",
        entryPath: "/home/theo/.npm/_npx/abc123/node_modules/@t2code/cli/dist/bin.mjs",
        version,
      }),
      expected,
    );
  }
});

it("formats serve suggestions to match the launching command", () => {
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/home/theo/.npm/_npx/abc/node_modules/@t2code/cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "npx @t2code/cli@nightly serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/tmp/bunx-1000-@t2code-cli@latest/node_modules/@t2code/cli/dist/bin.mjs",
      version: "0.0.31",
    }),
    "bunx @t2code/cli serve",
  );
  assert.equal(
    formatCliCommand({
      subcommand: "serve",
      entryPath: "/usr/local/lib/node_modules/@t2code/cli/dist/bin.mjs",
      version: "0.0.31-nightly.20260729",
    }),
    "t2code serve",
  );
});
