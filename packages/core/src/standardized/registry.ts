import type { Deployment } from "./types";
import deployments from "./deployments.json";

export const DEPLOYMENTS = deployments as Deployment[];

/**
 * Whether a `{ protocol, chainId }` pair names a table this service can actually serve:
 * either a registered Messari deployment, or `"erc4626"`, which is served from the
 * Substreams sink rather than the registry and so has no entry here.
 *
 * Exists so a table request for a protocol nobody indexes can be refused *before* it is
 * charged for. `DataProvider.table` answers an unknown protocol with an empty result, which
 * on its own is honest — but a payer who has already settled has then bought nothing, and
 * on the Arc rail settlement happens before any handler runs, so the refusal has to be
 * possible from pre-payment validation.
 */
export const knownProtocol = (protocol: string, chainId: string): boolean =>
  protocol === "erc4626" || DEPLOYMENTS.some(d => d.protocol === protocol && d.chainId === chainId);
