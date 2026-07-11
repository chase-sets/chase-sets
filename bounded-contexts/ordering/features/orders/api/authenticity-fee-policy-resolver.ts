import type { AuthenticityCheckFeePolicyValue } from "../domain/authenticity-check-fee";

export type ResolvedAuthenticityCheckFeePolicy = Readonly<{
  value: AuthenticityCheckFeePolicyValue;
  /** "policy" when an admin-managed document was active, "fallback" when the compiled default was used. */
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  resolvedAt: string;
}>;

/**
 * Ordering-owned port for resolving the authenticity-check fee policy at
 * quote time (checkout preview) and at order-creation time (authoritative
 * freeze). Commercial Terms provides the concrete implementation (see
 * `@chase-sets/commercial-terms/server`'s `createAuthenticityFeePolicyResolver`)
 * and it is wired in as the `authenticityFeePolicyResolver` host port
 * declared in `ordering/context.json` -- Ordering depends only on this
 * interface, never on Commercial Terms' package or storage.
 */
export interface AuthenticityFeePolicyResolver {
  resolveAuthenticityFeePolicy(params?: Readonly<{ at?: string }>): Promise<ResolvedAuthenticityCheckFeePolicy>;
}
