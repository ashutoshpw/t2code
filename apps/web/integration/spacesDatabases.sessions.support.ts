import type { AuthSessionState, EnvironmentId } from "@t2code/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

/** One session state atom per environment, standing in for the `/session` HTTP fetch. */
export const sessionStates = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
