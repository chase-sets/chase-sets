import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { isCanonicalMoneyAmount, normalizeMoneyAmount } from "@chase-sets/primitives/money";
import type {
  EconomicsFact,
  Money,
  NativeMarketplaceEconomicsProvider,
  ResolveEconomicsRequest,
  SourceEconomics,
} from "../../domain/contracts";
import { assertSourceEconomics } from "../../domain/contracts";
import {
  assertEconomicsPolicyEffectiveAt,
  parseResolvedEconomicsPolicy,
  type ResolvedEconomicsPolicy,
} from "../../domain/policy";
import { canonicalSha256 } from "../../domain/revision";

export function createNativeMarketplaceEconomicsProvider(
  input: Readonly<{
    commercialTermsResolver: Pick<CommercialTermsResolver, "resolveListingTerms">;
    resolvePolicy: (effectiveAt: string) => Promise<ResolvedEconomicsPolicy>;
  }>,
): NativeMarketplaceEconomicsProvider {
  return {
    async resolve(request: ResolveEconomicsRequest): Promise<SourceEconomics> {
      if (request.scope.kind !== "native-marketplace") {
        throw new Error("Native marketplace Economics requires the native-marketplace scope.");
      }
      const policy = parseResolvedEconomicsPolicy(await input.resolvePolicy(request.effectiveAt));
      assertEconomicsPolicyEffectiveAt(policy, request.effectiveAt);
      try {
        const terms = await input.commercialTermsResolver.resolveListingTerms({
          accountId: request.accountId,
          amount: request.marketUnitPrice.amount,
          effectiveAt: request.effectiveAt,
        });
        if (
          terms.accountId !== request.accountId ||
          terms.basisAmount !== request.marketUnitPrice.amount ||
          terms.resolvedAt !== request.effectiveAt
        ) {
          throw new Error("Commercial Terms returned facts for different resolution coordinates.");
        }
        const currency = request.marketUnitPrice.currency;
        const commercialSource = {
          kind: "commercial-terms" as const,
          agreementId: terms.agreementId,
          revision: canonicalSha256({
            scheduleId: terms.scheduleId,
            agreementId: terms.agreementId,
            marketplaceSalesFeePercentageBps: terms.marketplaceSalesFeePercentageBps,
            marketplaceSalesFeeFixedAmount: terms.marketplaceSalesFeeFixedAmount,
            marketplaceSalesFeeCapAmount: terms.marketplaceSalesFeeCapAmount,
            shippingAllowancePercentageBps: terms.shippingAllowancePercentageBps,
          }),
        };
        const policySource = { kind: "policy-owned" as const, policyRevision: policy.policyRevision };
        const commercialObservedAt = terms.resolvedAt;
        const money = (amount: string): Money => {
          if (!isCanonicalMoneyAmount(amount)) throw new Error("Commercial Terms returned malformed money.");
          return { amount: normalizeMoneyAmount(amount), currency };
        };
        const fact = <T>(value: T, source: EconomicsFact<T>["source"], observedAt: string): EconomicsFact<T> => ({
          sourceValue: value,
          source,
          effectiveValue: value,
          override: null,
          observedAt,
        });

        const resolved: SourceEconomics = {
          kind: "resolved",
          policy,
          facts: {
            platformFeeRelativeBps: fact(
              terms.marketplaceSalesFeePercentageBps,
              commercialSource,
              commercialObservedAt,
            ),
            platformFeeFixedPerUnitAmount: fact(
              money(terms.marketplaceSalesFeeFixedAmount),
              commercialSource,
              commercialObservedAt,
            ),
            platformFeeCapPerUnitAmount: fact(
              terms.marketplaceSalesFeeCapAmount === null ? null : money(terms.marketplaceSalesFeeCapAmount),
              commercialSource,
              commercialObservedAt,
            ),
            sellerHandlingRelativeBps: fact(policy.value.sellerHandlingRelativeBps, policySource, policy.observedAt),
            sellerHandlingFixedPerUnitAmount: fact(
              money(policy.value.sellerHandlingFixedPerUnitAmount),
              policySource,
              policy.observedAt,
            ),
            sellerHandlingCapPerUnitAmount: fact(
              policy.value.sellerHandlingCapPerUnitAmount === null
                ? null
                : money(policy.value.sellerHandlingCapPerUnitAmount),
              policySource,
              policy.observedAt,
            ),
            shippingAllowanceBps: fact(terms.shippingAllowancePercentageBps, commercialSource, commercialObservedAt),
          },
        };
        assertSourceEconomics(resolved, currency);
        return resolved;
      } catch {
        return { kind: "unavailable", reason: "terms-unavailable", policy };
      }
    },
  };
}
