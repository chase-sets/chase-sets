import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyResolver } from "@chase-sets/platform-policy/resolver";
import {
  createCommercialTermsResolver,
  createNoopCommercialTermsResolver,
  resolveStandardScheduleTerms,
  type PublishedStandardScheduleTerms,
} from "./features/resolutions/read-model/resolve";
import type { CommercialAccountType } from "./support/runtime-support/common";
import {
  checkoutProcessingFeePolicy,
  type CheckoutProcessingFeePolicyValue,
} from "./features/checkout-processing-fee/domain/policy";
import { authenticityFeePolicy, type AuthenticityFeePolicyValue } from "./features/authenticity-fee/domain/policy";
import { marketplaceSalesFeeSchedulePolicy } from "./features/marketplace-sales-fee/domain/policy";

export type {
  CommercialTermsResolver,
  ResolvedCommercialTerms,
  ResolvedListingTermsSession,
} from "./features/resolutions/read-model/resolve";
export type { CommercialTermsAccountSource } from "./features/resolutions/read-model/resolve";

export function createCommercialTermsServer(deps: Readonly<{ db: PgQueryable }>) {
  return createCommercialTermsResolver(deps);
}

export { createCommercialTermsResolver, createNoopCommercialTermsResolver };
export { quoteLockedMarketplaceFeeTerms } from "./features/resolutions/read-model/resolve";
export type { LockedMarketplaceFeeTerms } from "./features/resolutions/read-model/resolve";

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

export type { PublishedStandardScheduleTerms };

export type StandardScheduleResolver = Readonly<{
  /**
   * `accountType` accepts a plain string (not the branded `CommercialAccountType`)
   * because this port crosses into Platform Operations, which does not
   * carry that type -- an unrecognized value falls back to "personal"
   * rather than throwing, since a bad query parameter on an admin
   * dashboard should degrade, not 500 the whole monitor request.
   */
  resolveStandardScheduleTerms: (
    params?: Readonly<{ accountType?: string; effectiveAt?: string }>,
  ) => Promise<PublishedStandardScheduleTerms>;
}>;

function coerceCommercialAccountType(value: string | undefined): CommercialAccountType {
  return value === "personal" || value === "business" || value === "enterprise" ? value : "personal";
}

/**
 * Cross-context read port for the published standard (non-founders) fee
 * schedule: Platform Operations' offer-economics monitor consumes
 * this to compute the foregone-fee estimate for the 0%-locked cohort
 * (`percentageBps` applied to locked GMV, `fixedAmount` applied per trade)
 * without ever querying `platform_policy_documents` directly. Mirrors
 * `createCheckoutProcessingFeePolicyResolver`'s shape; unlike that resolver,
 * this reads the raw schedule table straight (no `PolicyResolver`/compiled
 * fallback), matching `resolvePublicStandardListingTerms`'s existing
 * fail-open-with-zeros behavior when no schedule document is active.
 */
export function createStandardScheduleResolver(db: PgQueryable): StandardScheduleResolver {
  return {
    resolveStandardScheduleTerms: (params) =>
      resolveStandardScheduleTerms(db, {
        accountType: coerceCommercialAccountType(params?.accountType),
        effectiveAt: params?.effectiveAt,
      }),
  };
}

export function createNoopStandardScheduleResolver(): StandardScheduleResolver {
  return {
    resolveStandardScheduleTerms: async (params) => ({
      accountType: coerceCommercialAccountType(params?.accountType),
      marketplaceSalesFeePercentageBps: 0,
      marketplaceSalesFeeFixedAmount: "0.00",
      scheduleId: null,
      scheduleLabel: null,
      resolvedAt: params?.effectiveAt ?? new Date().toISOString(),
    }),
  };
}

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

/**
 * Policy definitions for the platform policy console: Platform
 * Operations imports these (via `policyConsoleCrossContext`, assembled in
 * the `platform-api` composition root) to list, show history for, and
 * revise these policies through the shared machinery -- without ever
 * importing Commercial Terms' domain code directly. Schedules and
 * agreements deliberately stay off this list -- they keep their own
 * `/terms` admin surface, which has richer, account-targeted semantics.
 */
export { checkoutProcessingFeePolicy } from "./features/checkout-processing-fee/domain/policy";
export { authenticityFeePolicy } from "./features/authenticity-fee/domain/policy";
export { marketplaceSalesFeeSchedulePolicy } from "./features/marketplace-sales-fee/domain/policy";
