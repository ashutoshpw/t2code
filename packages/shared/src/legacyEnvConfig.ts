import { legacyEnvName } from "./legacyEnv.ts";
import * as Config from "effect/Config";
import * as Redacted from "effect/Redacted";

/**
 * Env-backed Config reads that honor a variable's legacy T3CODE_* name. When
 * the T2 name does not resolve, the read falls back to the legacy name. Note
 * Config.orElse also catches invalid values on the T2 name, so a malformed T2
 * value with a valid legacy value resolves to the legacy value during the
 * migration window. The legacy names themselves live in ./legacyEnv.ts.
 */
const withLegacyFallback = <A>(
  name: string,
  read: (name: string) => Config.Config<A>,
): Config.Config<A> => {
  const legacyName = legacyEnvName(name);
  if (legacyName === undefined) return read(name);
  return read(name).pipe(Config.orElse(() => read(legacyName)));
};

export const envStringConfig = (name: string): Config.Config<string> =>
  withLegacyFallback(name, Config.string);

export const envIntConfig = (name: string): Config.Config<number> =>
  withLegacyFallback(name, Config.int);

export const envBooleanConfig = (name: string): Config.Config<boolean> =>
  withLegacyFallback(name, Config.boolean);

export const envRedactedConfig = (name: string): Config.Config<Redacted.Redacted> =>
  withLegacyFallback(name, Config.redacted);
