import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/schema";
import { ProviderDriverKind } from "@t2code/contracts";

import {
  acpPermissionOutcome,
  mapAcpToAdapterError,
  selectAcpPermissionOptionId,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("returns the exact advertised option IDs for each decision", () => {
    const request = {
      toolCall: { toolCallId: "tool-1", title: "Run" },
      options: [
        { optionId: "opaque_allow-always", name: "Always", kind: "allow_always" },
        { optionId: "allow_once_native", name: "Once", kind: "allow_once" },
        { optionId: "reject__once", name: "Reject", kind: "reject_once" },
      ],
    } satisfies EffectAcpSchema.RequestPermissionRequest;
    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBe("opaque_allow-always");
    expect(selectAcpPermissionOptionId(request, "accept")).toBe("allow_once_native");
    expect(selectAcpPermissionOptionId(request, "decline")).toBe("reject__once");
    expect(selectAcpPermissionOptionId(request, "cancel")).toBeUndefined();
    expect(selectAcpPermissionOptionId({ ...request, options: [] }, "accept")).toBeUndefined();
    expect(
      selectAcpPermissionOptionId(
        {
          ...request,
          options: [
            { optionId: "", name: "Invalid", kind: "allow_once" },
            { optionId: "opaque-once", name: "Once", kind: "allow_once" },
          ],
        },
        "accept",
      ),
    ).toBe("opaque-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
