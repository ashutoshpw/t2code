// @effect-diagnostics globalConsole:off - the deprecation notice must reach stderr from plain (non-Effect) callers.
/**
 * Legacy env-name compatibility for the T3CODE_* -> T2CODE_* rename.
 *
 * This module is the only place legacy names may be spelled. Variables that
 * arrive from outside the repo (user shells, hosting dashboards, .env files,
 * installed service units) keep working through these aliases; reads prefer
 * the T2 name and fall back to the legacy one with a one-time notice.
 *
 * Cutover: once a release cycle has shipped with T2CODE_* names documented
 * everywhere, delete entries from LEGACY_ENV_ALIASES and drop the fallback
 * call sites. Internal-only variables were renamed without aliases and must
 * not appear here.
 */

const LEGACY_ENV_ALIASES: Readonly<Record<string, string>> = {
  T2CODE_HOME: "T3CODE_HOME",
  T2CODE_CHANNEL: "T3CODE_CHANNEL",
  T2CODE_VERSION: "T3CODE_VERSION",
  T2CODE_INSTALL_BIN_DIR: "T3CODE_INSTALL_BIN_DIR",
  T2CODE_RELEASE_BASE_URL: "T3CODE_RELEASE_BASE_URL",
  T2CODE_DEV_AUTH_TOKEN: "T3CODE_DEV_AUTH_TOKEN",
  T2CODE_BITBUCKET_EMAIL: "T3CODE_BITBUCKET_EMAIL",
  T2CODE_BITBUCKET_API_TOKEN: "T3CODE_BITBUCKET_API_TOKEN",
  T2CODE_BITBUCKET_ACCESS_TOKEN: "T3CODE_BITBUCKET_ACCESS_TOKEN",
  T2CODE_BITBUCKET_API_BASE_URL: "T3CODE_BITBUCKET_API_BASE_URL",
  T2CODE_HOSTED_APP_URL: "T3CODE_HOSTED_APP_URL",
  T2CODE_CLERK_PUBLISHABLE_KEY: "T3CODE_CLERK_PUBLISHABLE_KEY",
  T2CODE_CLERK_JWT_TEMPLATE: "T3CODE_CLERK_JWT_TEMPLATE",
  T2CODE_CLERK_CLI_OAUTH_CLIENT_ID: "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  T2CODE_CLERK_PASSKEY_RP_DOMAINS: "T3CODE_CLERK_PASSKEY_RP_DOMAINS",
  T2CODE_POSTHOG_KEY: "T3CODE_POSTHOG_KEY",
  T2CODE_POSTHOG_HOST: "T3CODE_POSTHOG_HOST",
  T2CODE_OTLP_TRACES_URL: "T3CODE_OTLP_TRACES_URL",
  T2CODE_OTLP_METRICS_URL: "T3CODE_OTLP_METRICS_URL",
  T2CODE_OTLP_EXPORT_INTERVAL_MS: "T3CODE_OTLP_EXPORT_INTERVAL_MS",
  T2CODE_OTLP_SERVICE_NAME: "T3CODE_OTLP_SERVICE_NAME",
  T2CODE_TELEMETRY_ENABLED: "T3CODE_TELEMETRY_ENABLED",
  T2CODE_IOS_PERSONAL_TEAM: "T3CODE_IOS_PERSONAL_TEAM",
  T2CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID",
  T2CODE_MOBILE_UPDATES_ENABLED: "T3CODE_MOBILE_UPDATES_ENABLED",
  T2CODE_ANDROID_GOOGLE_SERVICES_FILE: "T3CODE_ANDROID_GOOGLE_SERVICES_FILE",
};

/** The legacy name for a T2 env variable, when one exists. */
export function legacyEnvName(name: string): string | undefined {
  return LEGACY_ENV_ALIASES[name];
}

const warnedLegacyNames = new Set<string>();

function warnLegacyEnvOnce(legacyName: string, name: string): void {
  if (warnedLegacyNames.has(legacyName)) return;
  warnedLegacyNames.add(legacyName);
  console.error(`[t2code] ${legacyName} is deprecated; set ${name} instead.`);
}

/**
 * Reads an env var by its T2 name, falling back to the legacy name with a
 * one-time deprecation notice. An empty-string value counts as set: callers
 * that treat empty as absent do their own trimming afterwards.
 */
export function envWithLegacyFallback(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value !== undefined) return value;
  const legacyName = LEGACY_ENV_ALIASES[name];
  if (legacyName === undefined) return undefined;
  const legacyValue = env[legacyName];
  if (legacyValue === undefined) return undefined;
  warnLegacyEnvOnce(legacyName, name);
  return legacyValue;
}
