import {
  DEFAULT_SERVER_SETTINGS,
  ServerConfigStreamSettingsUpdatedEvent,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t2code/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });
});

const settingsEventCodec = Schema.toCodecJson(ServerConfigStreamSettingsUpdatedEvent);
const decodeSettingsEvent = Schema.decodeUnknownSync(settingsEventCodec);
const encodeSettingsEvent = Schema.encodeUnknownSync(settingsEventCodec);

it("projects authoritative Spaces enable/remove, preserves legacy events, and replaces reconnect capability state", () => {
  const spaces = {
    version: 2,
    limits: {
      maxListRows: 50,
      maxListResponseBytes: 65536,
      maxBlockWindowBlocks: 100,
      maxBlockWindowResponseBytes: 262144,
      maxMutationNodes: 100,
      maxMutationBytes: 262144,
      maxBlockBytes: 32768,
      maxDepth: 16,
      maxPageBlocks: 10000,
      maxPageBytes: 33554432,
      maxIdBytes: 128,
      maxTitleBytes: 512,
      maxOrderBytes: 128,
      maxCursorBytes: 1024,
      maxReceiptBytes: 65536,
      maxReceiptRows: 10000,
      maxReceiptStorageBytes: 67108864,
      maxEpochRows: 9,
      receiptRetentionMs: 604800000,
      cleanupBatchRows: 100,
    },
  };
  const advertised = {
    ...spaces,
    features: {
      blockMoves: true,
      referenceResolution: true,
      recovery: true,
      search: true,
      contextCapture: true,
      assets: true,
    },
  };
  const config = {
    settings: DEFAULT_SERVER_SETTINGS,
    environment: { capabilities: { repositoryIdentity: true } },
  } as unknown as ServerConfig;
  const snapshot: ServerConfigStreamEvent = { version: 1, type: "snapshot", config };
  let state = applyServerConfigProjection(Option.none(), snapshot);
  const event = (payload: object) =>
    decodeSettingsEvent(
      encodeSettingsEvent({
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS, ...payload },
      }),
    );
  state = applyServerConfigProjection(state, event({ spaces: advertised }));
  expect(Option.getOrThrow(state).config.environment.capabilities.spaces).toEqual(advertised);
  state = applyServerConfigProjection(state, event({}));
  expect(Option.getOrThrow(state).config.environment.capabilities.spaces).toEqual(advertised);
  state = applyServerConfigProjection(state, event({ spaces }));
  expect(Option.getOrThrow(state).config.environment.capabilities.spaces).toEqual(spaces);
  expect(Option.getOrThrow(state).config.environment.capabilities.spaces?.features).toBeUndefined();
  state = applyServerConfigProjection(state, event({ spaces: advertised }));
  state = applyServerConfigProjection(state, {
    ...snapshot,
    config: {
      ...config,
      environment: {
        ...config.environment,
        capabilities: { ...config.environment.capabilities, spaces },
      },
    },
  });
  expect(Option.getOrThrow(state).config.environment.capabilities.spaces).toEqual(spaces);
  expect(Option.getOrThrow(state).config.environment.capabilities.spaces?.features).toBeUndefined();
  state = applyServerConfigProjection(state, event({ spaces: advertised }));
  state = applyServerConfigProjection(state, event({ spaces: null }));
  expect(Object.hasOwn(Option.getOrThrow(state).config.environment.capabilities, "spaces")).toBe(
    false,
  );
  expect(Option.getOrThrow(state).config.environment.capabilities.repositoryIdentity).toBe(true);
  state = applyServerConfigProjection(state, event({ spaces }));
  state = applyServerConfigProjection(state, snapshot);
  expect(Object.hasOwn(Option.getOrThrow(state).config.environment.capabilities, "spaces")).toBe(
    false,
  );
});
