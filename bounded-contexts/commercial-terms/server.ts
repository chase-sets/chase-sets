import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import {
  createCommercialTermsResolver,
  createNoopCommercialTermsResolver,
} from "./features/resolutions/read-model/resolve";
import {
  checkoutProcessingFeePolicy,
  type CheckoutProcessingFeePolicyValue,
} from "./features/checkout-processing-fee/domain/policy";
import { authenticityFeePolicy, type AuthenticityFeePolicyValue } from "./features/authenticity-fee/domain/policy";

export type { CommercialTermsResolver, ResolvedCommercialTerms } from "./features/resolutions/read-model/resolve";
export type { CommercialTermsAccountSource } from "./features/resolutions/read-model/resolve";

export function createCommercialTermsServer(deps: Readonly<{ db: PgQueryable }>) {
  return createCommercialTermsResolver(deps);
}

export { createCommercialTermsResolver, createNoopCommercialTermsResolver };

export type ResolvedCheckoutProcessingFeePolicy = Readonly<{
  value: CheckoutProcessingFeePolicyValue;
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  resolvedAt: string;
}>;

export type CheckoutProcessingFeePolicyResolver = Readonly<{
  resolveCheckoutProcessingFeePolicy: (
    params?: Readonly<{ at?: string }>,
  ) => Promise<ResolvedCheckoutProcessingFeePolicy>;
}>;

/**
 * Cross-context read port for the checkout processing-fee policy: Payments
 * consumes this (as its `checkoutProcessingFeePolicyResolver` host port)
 * without ever querying Commercial Terms' storage directly. Unlike
 * `createCommercialTermsResolver`, this constructs a fresh
 * `PolicyResolver` (and therefore a fresh, unpopulated cache) on every
 * call rather than reusing one long-lived instance: Payments does not run
 * Commercial Terms' own projector, so it has no way to receive that
 * resolver's push-based cache invalidation, and a stale money policy is a
 * worse failure mode than one extra indexed read per quote. This matches
 * the existing cross-context resolver precedent (`createCommercialTermsResolver`
 * also queries fresh, uncached, on every call).
 */
export function createCheckoutProcessingFeePolicyResolver(db: PgQueryable): CheckoutProcessingFeePolicyResolver {
  return {
    resolveCheckoutProcessingFeePolicy: async (params) => {
      const resolver = createPolicyResolver({ db });
      const resolved = await resolver.resolvePolicy(
        checkoutProcessingFeePolicy,
        params?.at ? { at: params.at } : undefined,
      );
      return {
        value: resolved.value,
        source: resolved.source,
        documentId: resolved.documentId,
        effectiveFrom: resolved.effectiveFrom,
        resolvedAt: resolved.resolvedAt,
      };
    },
  };
}

export function createNoopCheckoutProcessingFeePolicyResolver(): CheckoutProcessingFeePolicyResolver {
  return {
    resolveCheckoutProcessingFeePolicy: async (params) => ({
      value: checkoutProcessingFeePolicy.defaultValue,
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      resolvedAt: params?.at ?? new Date().toISOString(),
    }),
  };
}

export type { CheckoutProcessingFeePolicyValue } from "./features/checkout-processing-fee/domain/policy";

export type ResolvedAuthenticityFeePolicy = Readonly<{
  value: AuthenticityFeePolicyValue;
  source: "policy" | "fallback";
  documentId: string | null;
  effectiveFrom: string | null;
  resolvedAt: string;
}>;

export type AuthenticityFeePolicyResolver = Readonly<{
  resolveAuthenticityFeePolicy: (params?: Readonly<{ at?: string }>) => Promise<ResolvedAuthenticityFeePolicy>;
}>;

/**
 * Cross-context read port for the authenticity-check fee policy (m109):
 * Ordering consumes this (as its `authenticityFeePolicyResolver`
 * host port) without ever querying Commercial Terms' storage directly.
 * Mirrors `createCheckoutProcessingFeePolicyResolver` exactly, including
 * the fresh-uncached-resolver rationale documented there.
 */
export function createAuthenticityFeePolicyResolver(db: PgQueryable): AuthenticityFeePolicyResolver {
  return {
    resolveAuthenticityFeePolicy: async (params) => {
      const resolver = createPolicyResolver({ db });
      const resolved = await resolver.resolvePolicy(authenticityFeePolicy, params?.at ? { at: params.at } : undefined);
      return {
        value: resolved.value,
        source: resolved.source,
        documentId: resolved.documentId,
        effectiveFrom: resolved.effectiveFrom,
        resolvedAt: resolved.resolvedAt,
      };
    },
  };
}

export function createNoopAuthenticityFeePolicyResolver(): AuthenticityFeePolicyResolver {
  return {
    resolveAuthenticityFeePolicy: async (params) => ({
      value: authenticityFeePolicy.defaultValue,
      source: "fallback",
      documentId: null,
      effectiveFrom: null,
      resolvedAt: params?.at ?? new Date().toISOString(),
    }),
  };
}

export type {
  AuthenticityFeePolicyValue,
  AuthenticityFeeBand,
  AuthenticityFeeCategory,
} from "./features/authenticity-fee/domain/policy";
