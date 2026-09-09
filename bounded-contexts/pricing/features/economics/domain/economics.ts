import type { ChannelProviderIdentity } from "@chase-sets/channels";
import {
  assertEconomicsFacts,
  economicsScopeKey,
  parseResolveEconomicsRequest,
  requireRfc3339Instant,
  type Economics,
  type EconomicsFacts,
  type EconomicsScope,
  type ResolveEconomicsRequest,
  type SourceEconomics,
} from "./contracts";
import type { CapitalCycleObservations } from "./observations";
import type { CostBasisFacts, CycleFacts } from "./derivation";
import { applyEconomicsOverrides, economicsOverrideRevisionMaterial, type EconomicsOverridesState } from "./overrides";
import { canonicalSha256 } from "./revision";

export function buildEconomics(
  input: Readonly<{
    request: ResolveEconomicsRequest;
    channel: EconomicsScope;
    providerIdentity: ChannelProviderIdentity | null;
    sourceEconomics: Extract<SourceEconomics, { kind: "resolved" }>;
    costBasis: CostBasisFacts;
    cycle: CycleFacts;
    observations: CapitalCycleObservations;
    overrides: EconomicsOverridesState;
    pricingWatermark: string;
    inventoryObservedAt: string;
    pricingObservedAt: string;
  }>,
): Economics {
  const request = parseResolveEconomicsRequest(input.request);
  assertSubject(input, request);
  const sourceFacts: EconomicsFacts = {
    ...input.sourceEconomics.facts,
    costBasisShareOfMarketBps: input.costBasis.share,
    costBasisCoverageBps: input.costBasis.coverage,
    costBasisDiscountPerUnitAmount: input.costBasis.discount,
    turnaroundDays: input.cycle.turnaround,
    dailyReturnHurdle: input.cycle.dailyReturnHurdle,
  };
  assertEconomicsFacts(sourceFacts, request.marketUnitPrice.currency);
  for (const fact of Object.values(sourceFacts)) {
    if (fact.override !== null) throw new Error("Source Economics facts cannot arrive with an override applied.");
  }
  const facts = applyEconomicsOverrides(sourceFacts, input.overrides);
  assertEconomicsFacts(facts, request.marketUnitPrice.currency);

  return {
    accountId: request.accountId,
    channel: input.channel,
    currency: request.marketUnitPrice.currency,
    effectiveAt: request.effectiveAt,
    revision: canonicalSha256({
      request: {
        accountId: request.accountId,
        scope: request.scope,
        catalogItemId: request.catalogItemId,
        inventoryItemId: request.inventoryItemId,
        currency: request.marketUnitPrice.currency,
        marketUnitPriceAmount: request.marketUnitPrice.amount,
        quantity: request.quantity,
        effectiveAt: request.effectiveAt,
      },
      providerIdentity: input.providerIdentity,
      sourceFacts,
      inventoryWatermark: input.costBasis.inventoryWatermark,
      pricingWatermark: requireWatermark(input.pricingWatermark, "pricingWatermark"),
      inventoryObservedAt: requireObservationAt(input.inventoryObservedAt, request.effectiveAt, "inventoryObservedAt"),
      pricingObservedAt: requireObservationAt(input.pricingObservedAt, request.effectiveAt, "pricingObservedAt"),
      generatedAgeSeconds: 0,
      inventorySourceAgeSeconds: ageSeconds(input.inventoryObservedAt, request.effectiveAt),
      pricingSourceAgeSeconds: ageSeconds(input.pricingObservedAt, request.effectiveAt),
      observations: {
        hold: observationRevisionMaterial(input.observations.observedHold),
        turnaround: observationRevisionMaterial(input.observations.observedTurnaround),
      },
      overrides: economicsOverrideRevisionMaterial(input.overrides),
    }),
    facts,
    diagnostics: {
      ...input.cycle.diagnostics,
      inventoryWatermark: input.costBasis.inventoryWatermark,
      pricingWatermark: requireWatermark(input.pricingWatermark, "pricingWatermark"),
      generatedAt: request.effectiveAt,
      inventoryObservedAt: requireObservationAt(input.inventoryObservedAt, request.effectiveAt, "inventoryObservedAt"),
      pricingObservedAt: requireObservationAt(input.pricingObservedAt, request.effectiveAt, "pricingObservedAt"),
      generatedAgeSeconds: 0,
      inventorySourceAgeSeconds: ageSeconds(input.inventoryObservedAt, request.effectiveAt),
      pricingSourceAgeSeconds: ageSeconds(input.pricingObservedAt, request.effectiveAt),
    },
  };
}

function requireWatermark(value: string, name: string): string {
  if (value.length === 0 || value.trim() !== value) throw new Error(`${name} must be non-empty and already trimmed.`);
  return value;
}

function requireObservationAt(value: string, effectiveAt: string, name: string): string {
  const observedAt = requireRfc3339Instant(value, name);
  if (Date.parse(observedAt) > Date.parse(effectiveAt)) throw new Error(`${name} cannot be later than effectiveAt.`);
  return observedAt;
}

function ageSeconds(observedAt: string, effectiveAt: string): number {
  return (Date.parse(effectiveAt) - Date.parse(observedAt)) / 1_000;
}

function assertSubject(
  input: Readonly<{
    channel: EconomicsScope;
    providerIdentity: ChannelProviderIdentity | null;
    overrides: EconomicsOverridesState;
    sourceEconomics: Extract<SourceEconomics, { kind: "resolved" }>;
  }>,
  request: ResolveEconomicsRequest,
): void {
  if (
    input.channel.kind !== request.scope.kind ||
    (input.channel.kind === "channel-connection" &&
      request.scope.kind === "channel-connection" &&
      input.channel.connectionId !== request.scope.connectionId)
  ) {
    throw new Error("Resolved Economics scope does not match request.");
  }
  if (request.scope.kind === "native-marketplace" && input.providerIdentity !== null) {
    throw new Error("Native marketplace Economics cannot carry a provider identity.");
  }
  if (request.scope.kind === "channel-connection" && input.providerIdentity === null) {
    throw new Error("Channel connection Economics requires its resolved provider identity.");
  }
  if (
    input.overrides.key.accountId !== request.accountId ||
    input.overrides.key.scopeKey !== economicsScopeKey(request.scope) ||
    input.overrides.key.currency !== request.marketUnitPrice.currency
  ) {
    throw new Error("Economics overrides do not match the request subject.");
  }
}

function observationRevisionMaterial(observation: CapitalCycleObservations["observedHold"]): unknown {
  return observation === null
    ? null
    : {
        value: observation.value,
        sampleCount: observation.sampleCount,
        observedAt: observation.observedAt,
        policyRevision: observation.policyRevision,
        samples: observation.samples.map(({ sampleId, days, quantity, oldestObservationAt }) => ({
          sampleId,
          days,
          quantity,
          oldestObservationAt,
        })),
      };
}
