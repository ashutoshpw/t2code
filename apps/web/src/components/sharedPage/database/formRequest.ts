import {
  SPACE_PAGE_SHARE_BLOCK_PARAM,
  SPACE_PAGE_SHARE_FORM_ROUTE,
  SPACE_PAGE_SHARE_HEADER,
  SPACE_PAGE_SHARE_PAGE_PARAM,
  SPACE_PAGE_SHARE_VIEW_PARAM,
  SpaceSharedForm,
  SpaceSharedFormRejection,
  SpaceSharedPageFailure,
  type SpaceSharedFormSubmission,
} from "@t2code/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { classifyFailure, type Problem } from "./request";

const decodeForm = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedForm));
const decodeRejection = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedFormRejection));
const decodeFailure = Schema.decodeUnknownOption(Schema.toCodecJson(SpaceSharedPageFailure));

export type FormFetched =
  | { readonly ok: true; readonly value: SpaceSharedForm }
  | { readonly ok: false; readonly problem: Problem | "closed" };

export type FormSubmitted =
  | { readonly status: "received" }
  | { readonly status: "rejected"; readonly rejection: SpaceSharedFormRejection | null }
  | { readonly status: "closed" | "busy" | "ended" | "invalid" | "offline" };

export async function fetchSharedForm(
  credential: string,
  target: { readonly page?: string; readonly block: string; readonly view: string },
  signal: AbortSignal,
): Promise<FormFetched> {
  if (credential === "") return { ok: false, problem: "invalid" };
  const query = new URLSearchParams({
    [SPACE_PAGE_SHARE_BLOCK_PARAM]: target.block,
    [SPACE_PAGE_SHARE_VIEW_PARAM]: target.view,
  });
  if (target.page !== undefined) query.set(SPACE_PAGE_SHARE_PAGE_PARAM, target.page);
  try {
    const response = await fetch(`${SPACE_PAGE_SHARE_FORM_ROUTE}?${query}`, {
      signal,
      cache: "no-store",
      headers: { [SPACE_PAGE_SHARE_HEADER]: credential },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      if (Option.getOrUndefined(decodeFailure(body))?.reason === "closed")
        return { ok: false, problem: "closed" };
      return { ok: false, problem: classifyFailure(response.status, body) };
    }
    const decoded = decodeForm(await response.json());
    return Option.isSome(decoded)
      ? { ok: true, value: decoded.value }
      : { ok: false, problem: "invalid" };
  } catch {
    return { ok: false, problem: "offline" };
  }
}

export async function submitSharedForm(
  credential: string,
  submission: SpaceSharedFormSubmission,
): Promise<FormSubmitted> {
  try {
    const response = await fetch(SPACE_PAGE_SHARE_FORM_ROUTE, {
      method: "POST",
      cache: "no-store",
      headers: { [SPACE_PAGE_SHARE_HEADER]: credential, "content-type": "application/json" },
      body: JSON.stringify(submission),
    });
    if (response.ok) return { status: "received" };
    const body = await response.json().catch(() => null);
    if (response.status === 422)
      return { status: "rejected", rejection: Option.getOrNull(decodeRejection(body)) };
    if (response.status === 429) return { status: "busy" };
    if (Option.getOrUndefined(decodeFailure(body))?.reason === "closed")
      return { status: "closed" };
    const problem = classifyFailure(response.status, body);
    return {
      status: problem === "ended" ? "ended" : problem === "offline" ? "offline" : "invalid",
    };
  } catch {
    return { status: "offline" };
  }
}
