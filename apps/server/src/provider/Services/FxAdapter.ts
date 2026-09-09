/**
 * FxAdapter — shape type for the FX provider adapter.
 *
 * The driver bundles one adapter closure per provider instance. This module
 * keeps the shared adapter contract available to the server's provider
 * registry without adding a global service singleton.
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface FxAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
