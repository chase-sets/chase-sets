import {
  assertEconomicsFacts,
  parseResolveEconomicsRequest,
  type Economics,
  type EconomicsFacts,
  type ResolveEconomicsRequest,
  type ResolvedChannelConnection,
  type SourceEconomics,
} from "./contracts";
import type { CapitalCycleObservations } from "./observations";
import type { CostBasisFacts, CycleFacts } from "./derivation";
import { applyEconomicsOverrides, economicsOverrideRevisionMaterial, type EconomicsOverridesState } from "./overrides";
import { canonicalSha256 } from "./revision";

export function buildEconomics(
  input: Readonly<{
    request: ResolveEconomicsRequest;
    channel: ResolvedChannelConnection;
    sourceEconomics: Extract<SourceEconomics, { kind: "resolved" }>;
    costBasis: CostBasisFacts;
    cycle: CycleFacts;
    observations: CapitalCycleObservations;
    overrides: EconomicsOverridesState;
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
        connectionId: request.connectionId,
        catalogItemId: request.catalogItemId,
        inventoryItemId: request.inventoryItemId,
        currency: request.marketUnitPrice.currency,
        marketUnitPriceAmount: request.marketUnitPrice.amount,
        quantity: request.quantity,
        effectiveAt: request.effectiveAt,
      },
      providerIdentity: input.sourceEconomics.providerIdentity,
      sourceFacts,
      inventoryWatermark: input.costBasis.inventoryWatermark,
      observations: {
        hold: observationRevisionMaterial(input.observations.observedHold),
        turnaround: observationRevisionMaterial(input.observations.observedTurnaround),
      },
      overrides: economicsOverrideRevisionMaterial(input.overrides),
    }),
    facts,
    diagnostics: input.cycle.diagnostics,
  };
}

function assertSubject(
  input: Readonly<{
    channel: ResolvedChannelConnection;
    overrides: EconomicsOverridesState;
    sourceEconomics: Extract<SourceEconomics, { kind: "resolved" }>;
  }>,
  request: ResolveEconomicsRequest,
): void {
  if (input.channel.connectionId !== request.connectionId)
    throw new Error("Resolved Channel connection does not match request.");
  if (
    input.channel.providerKey !== input.sourceEconomics.providerIdentity.providerKey ||
    input.channel.environment !== input.sourceEconomics.providerIdentity.environment
  ) {
    throw new Error("Resolved provider does not match the Channel connection.");
  }
  if (
    input.overrides.key.accountId !== request.accountId ||
    input.overrides.key.connectionId !== request.connectionId ||
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
