import { SPACE_PAGE_SHARE_HEADER, SpaceSharedPageFailure } from "@t2code/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type Problem = "ended" | "invalid" | "unavailable" | "offline";
export type Fetched<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: Problem };

const decodeFailure = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedPageFailure));

/** The same mapping the page loader uses: a refused cursor surfaces as `unavailable`. */
export function classifyFailure(status: number, body: unknown): Problem {
  if (status >= 500 || status === 429) return "offline";
  const reason = Option.getOrUndefined(decodeFailure(body))?.reason;
  if (reason === "inactive") return "ended";
  if (reason === "unavailable") return "unavailable";
  return "invalid";
}

/** Public JSON read: the credential travels in a header, never in the URL. */
export async function sharedGet<A>(
  route: string,
  params: Readonly<Record<string, string | undefined>>,
  credential: string,
  decode: (body: unknown) => Option.Option<A>,
  signal: AbortSignal,
): Promise<Fetched<A>> {
  if (credential === "") return { ok: false, problem: "invalid" };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, value);
  }
  try {
    const response = await fetch(`${route}?${query}`, {
      signal,
      cache: "no-store",
      headers: { [SPACE_PAGE_SHARE_HEADER]: credential },
    });
    if (!response.ok) {
      return {
        ok: false,
        problem: classifyFailure(response.status, await response.json().catch(() => null)),
      };
    }
    const decoded = decode(await response.json());
    return Option.isSome(decoded)
      ? { ok: true, value: decoded.value }
      : { ok: false, problem: "invalid" };
  } catch {
    return { ok: false, problem: "offline" };
  }
}
