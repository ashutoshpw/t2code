import { makeSecretProviderDefinitionRegistry } from "@t2code/secret-provider-core/shared/definition";
import * as OnePassword from "@t2code/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
