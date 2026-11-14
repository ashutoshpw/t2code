import { useClerk } from "@clerk/react";

import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";
import { retryClerkLoad } from "./clerkLoadFailure";

export function useT2ConnectAuthPrompt() {
  const clerk = useClerk();
  const openAuthPrompt = () => {
    if (clerk.status === "error") {
      retryClerkLoad();
      return;
    }
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  return { authPrompt: null, openAuthPrompt };
}
