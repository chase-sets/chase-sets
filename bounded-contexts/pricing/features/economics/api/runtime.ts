import type {
  ChannelConnectionIdentityReader,
  EconomicsProviderRegistry,
  ResolveEconomicsRequest,
  SourceEconomics,
} from "../domain/contracts";
import { parseResolveEconomicsRequest, requireRfc3339Instant } from "../domain/contracts";
import { deriveCostBasisFacts, deriveCycleFacts, deriveUnavailableCycleFacts } from "../domain/derivation";
import { buildEconomics } from "../domain/economics";
import { observeCapitalCycle } from "../domain/observations";
import { applyEconomicsOverrideToFact, economicsOverrideRevisionMaterial } from "../domain/overrides";
import { quoteSellerOverhead } from "../domain/overhead";
import { parseResolvedEconomicsPolicy, type ResolvedEconomicsPolicy } from "../domain/policy";
import { canonicalSha256 } from "../domain/revision";
import type { EconomicsEvidenceReader, EconomicsResolution, EconomicsResolver } from "../domain/resolution";
import { resolveSourceEconomics } from "../domain/source-resolution";
import type { EconomicsOverrideRuntime } from "./override-runtime";

export type EconomicsRuntimeDependencies = Readonly<{
  channelConnectionIdentityReader: ChannelConnectionIdentityReader;
  providerRegistry: EconomicsProviderRegistry;
  evidenceReader: EconomicsEvidenceReader;
  overrides: Pick<EconomicsOverrideRuntime, "loadAt">;
  resolvePolicy: (effectiveAt: string) => Promise<ResolvedEconomicsPolicy>;
}>;

export function createEconomicsRuntime(deps: EconomicsRuntimeDependencies): EconomicsResolver {
  return {
    resolve: async (rawRequest: ResolveEconomicsRequest): Promise<EconomicsResolution> => {
      const request = parseResolveEconomicsRequest(rawRequest);
      const { channel, source } = await resolveSourceEconomics({
        request,
        channelConnectionIdentityReader: deps.channelConnectionIdentityReader,
        providerRegistry: deps.providerRegistry,
      });
      const policy = parseResolvedEconomicsPolicy(source.policy ?? (await deps.resolvePolicy(request.effectiveAt)));
      if (source.kind === "resolved") assertProviderPolicyBinding(source, policy.policyRevision);

      const evidence = await deps.evidenceReader.resolve(request);
      assertWatermark(evidence.inventoryWatermark, "inventoryWatermark");
      assertWatermark(evidence.pricingWatermark, "pricingWatermark");
      assertObservedAt(evidence.inventoryObservedAt, request.effectiveAt, "inventoryObservedAt");
      assertObservedAt(evidence.pricingObservedAt, request.effectiveAt, "pricingObservedAt");
      const costBasis = deriveCostBasisFacts({
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        marketUnitPrice: request.marketUnitPrice,
        quantity: request.quantity,
        effectiveAt: request.effectiveAt,
        inventoryWatermark: evidence.inventoryWatermark,
        inventoryObservedAt: evidence.inventoryObservedAt,
        lots: evidence.costLots,
        policy,
      });
      const observations = observeCapitalCycle({
        accountId: request.accountId,
        currency: request.marketUnitPrice.currency,
        effectiveAt: request.effectiveAt,
        acquisitions: evidence.acquisitions,
        sales: evidence.sales,
        policy,
      });
      const overrides = await deps.overrides.loadAt(
        {
          accountId: request.accountId,
          connectionId: request.connectionId,
          currency: request.marketUnitPrice.currency,
        },
        request.effectiveAt,
      );

      if (source.kind === "unavailable") {
        const cycle = deriveUnavailableCycleFacts({ observations, policy, reason: source.reason });
        const facts = {
          costBasisShareOfMarketBps: applyEconomicsOverrideToFact(
            "costBasisShareOfMarketBps",
            costBasis.share,
            overrides,
          ),
          costBasisCoverageBps: applyEconomicsOverrideToFact("costBasisCoverageBps", costBasis.coverage, overrides),
          costBasisDiscountPerUnitAmount: applyEconomicsOverrideToFact(
            "costBasisDiscountPerUnitAmount",
            costBasis.discount,
            overrides,
          ),
          turnaroundDays: applyEconomicsOverrideToFact("turnaroundDays", cycle.turnaround, overrides),
          dailyReturnHurdle: applyEconomicsOverrideToFact("dailyReturnHurdle", cycle.dailyReturnHurdle, overrides),
        };
        return {
          kind: "unavailable",
          reason: source.reason,
          accountId: request.accountId,
          channel,
          currency: request.marketUnitPrice.currency,
          effectiveAt: request.effectiveAt,
          revision: canonicalSha256({
            request,
            channel,
            providerIdentity: source.providerIdentity,
            reason: source.reason,
            policy,
            facts,
            observations,
            inventoryWatermark: evidence.inventoryWatermark,
            pricingWatermark: evidence.pricingWatermark,
            inventoryObservedAt: evidence.inventoryObservedAt,
            pricingObservedAt: evidence.pricingObservedAt,
            overrides: economicsOverrideRevisionMaterial(overrides),
          }),
          facts,
          diagnostics: {
            ...cycle.diagnostics,
            inventoryWatermark: evidence.inventoryWatermark,
            pricingWatermark: evidence.pricingWatermark,
            generatedAt: request.effectiveAt,
            inventoryObservedAt: evidence.inventoryObservedAt,
            pricingObservedAt: evidence.pricingObservedAt,
            generatedAgeSeconds: 0,
            inventorySourceAgeSeconds: ageSeconds(evidence.inventoryObservedAt, request.effectiveAt),
            pricingSourceAgeSeconds: ageSeconds(evidence.pricingObservedAt, request.effectiveAt),
          },
        };
      }

      const overhead = quoteSellerOverhead(request.marketUnitPrice, request.quantity, {
        platformFeeRelativeBps: source.facts.platformFeeRelativeBps.sourceValue,
        platformFeeFixedPerUnitAmount: source.facts.platformFeeFixedPerUnitAmount.sourceValue,
        platformFeeCapPerUnitAmount: source.facts.platformFeeCapPerUnitAmount.sourceValue,
        sellerHandlingRelativeBps: source.facts.sellerHandlingRelativeBps.sourceValue,
        sellerHandlingFixedPerUnitAmount: source.facts.sellerHandlingFixedPerUnitAmount.sourceValue,
        sellerHandlingCapPerUnitAmount: source.facts.sellerHandlingCapPerUnitAmount.sourceValue,
      });
      const cycle = deriveCycleFacts({
        marketUnitPrice: request.marketUnitPrice,
        quantity: request.quantity,
        netProceedsAmount: overhead.netProceedsAmount,
        costBasisShareOfMarketBps: costBasis.share.sourceValue,
        costBasisDiscountPerUnitAmount: costBasis.discount.sourceValue,
        observations,
        policy,
        ...(costBasis.share.source.kind === "policy-default" ? { upstreamFailure: "cost-basis-unavailable" } : {}),
      });
      return {
        kind: "resolved",
        economics: buildEconomics({
          request,
          channel,
          sourceEconomics: source,
          costBasis,
          cycle,
          observations,
          overrides,
          pricingWatermark: evidence.pricingWatermark,
          inventoryObservedAt: evidence.inventoryObservedAt,
          pricingObservedAt: evidence.pricingObservedAt,
        }),
      };
    },
  };
}

function assertProviderPolicyBinding(
  source: Extract<SourceEconomics, { kind: "resolved" }>,
  policyRevision: string,
): void {
  for (const factName of [
    "sellerHandlingRelativeBps",
    "sellerHandlingFixedPerUnitAmount",
    "sellerHandlingCapPerUnitAmount",
  ] as const) {
    const factSource = source.facts[factName].source;
    if (factSource.kind !== "policy-owned" || factSource.policyRevision !== policyRevision) {
      throw new Error("Provider seller-handling facts do not match the resolved Economics policy.");
    }
  }
}

function assertWatermark(value: string, name: string): void {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${name} must be non-empty and already trimmed.`);
}

function assertObservedAt(value: string, effectiveAt: string, name: string): void {
  const observedAt = requireRfc3339Instant(value, name);
  if (Date.parse(observedAt) > Date.parse(effectiveAt)) throw new Error(`${name} cannot be later than effectiveAt.`);
}

function ageSeconds(observedAt: string, effectiveAt: string): number {
  return (Date.parse(effectiveAt) - Date.parse(observedAt)) / 1_000;
}
