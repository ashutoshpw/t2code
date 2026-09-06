import { createSourceControlEnvironmentAtoms } from "@t2code/client-runtime/state/source-control";

import { connectionAtomRuntime } from "../connection/runtime";

export const sourceControlEnvironment = createSourceControlEnvironmentAtoms(connectionAtomRuntime);
