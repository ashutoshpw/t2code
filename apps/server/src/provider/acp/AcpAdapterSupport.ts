import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderDriverKind,
  type ThreadId,
} from "@t2code/contracts";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

/** Select the agent-advertised option for a public approval decision. */
export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const kind = (() => {
    switch (decision) {
      case "acceptForSession":
      case "acceptAlways":
        return "allow_always" as const;
      case "accept":
        return "allow_once" as const;
      case "decline":
        return "reject_once" as const;
      case "cancel":
        return undefined;
    }
  })();
  if (kind === undefined) return undefined;
  const option = request.options.find(
    (entry) => entry.kind === kind && entry.optionId.trim().length > 0,
  );
  if (option !== undefined) return option.optionId;
  return undefined;
}

/** Advertise only approval decisions backed by the ACP request's option IDs. */
export function acpApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const options: ProviderApprovalOption[] = [];
  const hasOption = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.some((entry) => entry.kind === kind && entry.optionId.trim().length > 0);
  if (hasOption("allow_once")) {
    options.push({ decision: "accept", label: "Allow once" });
  }
  if (hasOption("allow_always")) {
    options.push({ decision: "acceptForSession", label: "Allow for this thread" });
  }
  // The public contract has no persistent-denial decision. Never surface a
  // generic "Deny" action that would silently select ACP's reject_always kind.
  if (hasOption("reject_once")) {
    options.push({ decision: "decline", label: "Deny" });
  }
  options.push({ decision: "cancel", label: "Cancel" });
  return options;
}
