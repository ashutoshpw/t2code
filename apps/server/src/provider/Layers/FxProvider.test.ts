import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import { FxSettings } from "@t2code/contracts";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  buildFxModels,
  buildFxModelsFromConfigOptions,
  buildFxModelsFromSessionSetup,
  buildFxSlashCommands,
  checkFxProviderStatus,
  parseFxModelsOutput,
  parseFxStatusOutput,
} from "./FxProvider.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);

describe("parseFxStatusOutput", () => {
  it("reads the active model and authentication source", () => {
    expect(
      parseFxStatusOutput(
        JSON.stringify({
          kind: "status",
          model: "vercel/auto",
          auth: "oauth",
          auth_refreshable: true,
          auth_help: "",
          permission_mode: "ask",
        }),
      ),
    ).toEqual({
      model: "vercel/auto",
      auth: { status: "authenticated", type: "oauth", label: "fx (oauth)" },
      message: undefined,
      permissionMode: "ask",
      authExpired: false,
      authRefreshable: true,
    });
  });

  it("treats an explicitly expired credential as unauthenticated", () => {
    const parsed = parseFxStatusOutput(
      JSON.stringify({
        kind: "status",
        model: "vercel/auto",
        auth: "oauth",
        auth_expired: true,
        auth_refreshable: true,
        auth_help: "Run fx login.",
        permission_mode: "ask",
      }),
    );

    expect(parsed?.auth).toEqual({ status: "unauthenticated" });
    expect(parsed?.authExpired).toBe(true);
    expect(parsed?.message).toBe("Run fx login.");
  });
});

describe("parseFxModelsOutput", () => {
  it("deduplicates and trims model IDs", () => {
    expect(
      parseFxModelsOutput(
        JSON.stringify({ kind: "models", ids: [" vercel/auto ", "vercel/auto", "", 42] }),
      ),
    ).toEqual({ models: ["vercel/auto"] });
  });
});

describe("buildFxModels", () => {
  it("marks the CLI-reported active model and preserves custom models", () => {
    const models = buildFxModels(["vercel/auto", "openai/gpt-5"], "openai/gpt-5", ["custom/model"]);

    expect(models.map((model) => [model.slug, model.isDefault ?? false, model.isCustom])).toEqual([
      ["vercel/auto", false, false],
      ["openai/gpt-5", true, false],
      ["custom/model", false, true],
    ]);
  });
});

describe("FX ACP metadata", () => {
  const modelConfig = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "openai/gpt-5",
    options: [
      { value: "vercel/auto", name: "Gateway Auto" },
      { value: "openai/gpt-5", name: "GPT 5" },
      { value: "openai/gpt-5", name: "Duplicate" },
    ],
  } satisfies EffectAcpSchema.SessionConfigOption;

  it("derives the model picker from ACP config options", () => {
    const models = buildFxModelsFromConfigOptions([modelConfig], ["custom/model"]);

    expect(models?.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      ["vercel/auto", "Gateway Auto", false],
      ["openai/gpt-5", "GPT 5", true],
      ["custom/model", "custom/model", false],
    ]);
  });

  it("falls back to ACP session model state when no model option is present", () => {
    const models = buildFxModelsFromSessionSetup(
      {
        configOptions: [],
        models: {
          currentModelId: "vercel/auto",
          availableModels: [{ modelId: "vercel/auto", name: "Gateway Auto" }],
        },
      },
      [],
    );

    expect(models?.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["vercel/auto", true],
    ]);
  });

  it("normalizes ACP slash commands and preserves input hints", () => {
    expect(
      buildFxSlashCommands([
        { name: " review ", description: " Review changes ", input: { hint: " path " } },
        { name: "review", description: "duplicate", input: null },
        { name: "", description: "ignored" },
      ]),
    ).toEqual([{ name: "review", description: "Review changes", input: { hint: "path" } }]);
  });
});

it.layer(NodeServices.layer)("checkFxProviderStatus", (it) => {
  it.effect("runs all probes in the requested workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          directory: NodeOS.tmpdir(),
          prefix: "t3code-fx-provider-",
        });
        const fxPath = writeFakeCli({
          directory: workspace,
          name: "fx",
          source: [
            'if (process.argv[2] === "--version") {',
            '  process.stdout.write("fx 0.3.0\\n");',
            "  process.exit(0);",
            "}",
            'if (process.argv[2] === "status") {',
            '  process.stdout.write(JSON.stringify({ kind: "status", model: "vercel/auto", auth: "oauth", permission_mode: "ask", workspace: process.cwd() }));',
            "  process.exit(0);",
            "}",
            'if (process.argv[2] === "models") {',
            '  process.stdout.write(JSON.stringify({ kind: "models", ids: ["vercel/auto", "openai/gpt-5"] }));',
            "  process.exit(0);",
            "}",
            "process.exit(1);",
          ].join("\n"),
        });

        const snapshot = yield* checkFxProviderStatus(
          decodeFxSettings({ enabled: true, binaryPath: fxPath }),
          process.env,
          workspace,
        );

        expect(snapshot.status).toBe("ready");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.version).toBe("0.3.0");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
          ["vercel/auto", true],
          ["openai/gpt-5", false],
        ]);
      }),
    ),
  );
});
