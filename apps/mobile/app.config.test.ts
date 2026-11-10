import { DEFAULT_HOSTED_APP_URL } from "@t2code/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      ["APP_VARIANT", "T2CODE_EAS_PROJECT_ID", "T2CODE_EXPO_OWNER", "T2CODE_APPLE_TEAM_ID"].flatMap(
        (key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]),
      ),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "codes.t2.mobile"],
  ["development", "codes.t2.mobile.dev"],
  ["preview", "codes.t2.mobile.preview"],
  ["production", "codes.t2.mobile"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t2.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `APPLE_TEAM_ID_UNSET.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("is inert without fork-owned Expo and Apple identities", async () => {
  const config = await loadConfig(undefined);
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.ios?.appleTeamId).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBeUndefined();
});

it("binds updates, owner, and team from T2CODE_* env", async () => {
  vi.stubEnv("T2CODE_EAS_PROJECT_ID", "11111111-2222-3333-4444-555555555555");
  vi.stubEnv("T2CODE_EXPO_OWNER", "example-owner");
  vi.stubEnv("T2CODE_APPLE_TEAM_ID", "TEAM123456");
  const config = await loadConfig(undefined);
  expect(config.updates).toMatchObject({
    enabled: true,
    url: "https://u.expo.dev/11111111-2222-3333-4444-555555555555",
  });
  expect(config.owner).toBe("example-owner");
  expect(config.ios?.appleTeamId).toBe("TEAM123456");
  expect(config.extra?.eas?.projectId).toBe("11111111-2222-3333-4444-555555555555");
});
