import type { ChannelProviderIdentity } from "@chase-sets/channels";
import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";
import type {
  EconomicsFact,
  EconomicsProvider,
  Money,
  ResolveEconomicsRequest,
  SourceEconomics,
} from "../../domain/contracts";
import { assertSourceEconomics } from "../../domain/contracts";
import type { ResolvedEconomicsPolicy } from "../../domain/policy";
import { canonicalSha256 } from "../../domain/revision";

export function createNativeCommercialTermsEconomicsProvider(
  input: Readonly<{
    identity: ChannelProviderIdentity;
    commercialTermsResolver: Pick<CommercialTermsResolver, "resolveListingTerms">;
    resolvePolicy: (effectiveAt: string) => Promise<ResolvedEconomicsPolicy>;
  }>,
): EconomicsProvider {
  return {
    identity: input.identity,
    async resolve(request: ResolveEconomicsRequest): Promise<SourceEconomics> {
      const policy = await input.resolvePolicy(request.effectiveAt);
      let terms: Awaited<ReturnType<CommercialTermsResolver["resolveListingTerms"]>>;
      try {
        terms = await input.commercialTermsResolver.resolveListingTerms({
          accountId: request.accountId,
          amount: request.marketUnitPrice.amount,
          effectiveAt: request.effectiveAt,
        });
      } catch {
        return { kind: "unavailable", providerIdentity: input.identity, reason: "terms-unavailable", policy };
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
      const money = (amount: string): Money => ({ amount: normalizeMoneyAmount(amount), currency });
      const fact = <T>(value: T, source: EconomicsFact<T>["source"], observedAt: string): EconomicsFact<T> => ({
        sourceValue: value,
        source,
        effectiveValue: value,
        override: null,
        observedAt,
      });

      const resolved: SourceEconomics = {
        kind: "resolved",
        providerIdentity: input.identity,
        policy,
        facts: {
          platformFeeRelativeBps: fact(terms.marketplaceSalesFeePercentageBps, commercialSource, commercialObservedAt),
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
    },
  };
}
