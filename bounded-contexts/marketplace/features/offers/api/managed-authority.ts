import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { buyerOfferPolicyCodec } from "../../offer-policy/domain/codec";
import type { BuyerOfferPolicySelection } from "../../offer-policy/domain/contracts";
import {
  assertBuyerOfferPolicyAdmission,
  BuyerOfferPolicyError,
  consumeBuyerOfferCommitment,
  decideBuyerOfferPolicy,
  evolveBuyerOfferPolicy,
  initialBuyerOfferPolicyState,
} from "../../offer-policy/domain/domain";
import type { MarketplaceOfferState } from "../domain/domain";

export type ManagedOfferTargetRequest = Readonly<{
  selection: BuyerOfferPolicySelection;
  currency: string;
  adjustmentBps: number;
  policyRevision: number;
  evaluatedAt: string;
}>;
export type ManagedOfferTarget =
  | Readonly<{ status: "target"; unitItemAmount: string; evidence: JsonObject }>
  | Readonly<{ status: "held"; reason: string; evidence: JsonObject }>;
/** Pricing owns loading and evaluation; the host binds this port to its public boundary. */
export type ManagedOfferPricing = Readonly<{
  evaluateTargets(requests: readonly ManagedOfferTargetRequest[]): Promise<readonly ManagedOfferTarget[]>;
}>;

export class ManagedOfferConflictError extends Error {
  constructor(
    public readonly code: "managed_offer_held" | "managed_offer_refresh_required" | "managed_offer_conflict",
  ) {
    super(
      code === "managed_offer_held"
        ? "Managed Offer is not currently available for acceptance."
        : "Offer authority or price changed. Refresh and confirm the current Offer before retrying.",
    );
    this.name = "ManagedOfferConflictError";
  }
}

export function createManagedOfferAuthority(eventStore: EventStore, pricing?: ManagedOfferPricing) {
  const { repository } = createAggregateCommandHandler({
    eventStore,
    codec: buyerOfferPolicyCodec,
    initialState: () => initialBuyerOfferPolicyState,
    evolve: evolveBuyerOfferPolicy,
    decide: decideBuyerOfferPolicy,
  });
  async function load(offer: MarketplaceOfferState) {
    const loaded = await repository.load(`marketplace.offer-policy-${offer.buyerOfferPolicyId}`);
    assertBuyerOfferPolicyAdmission(loaded.state, offer);
    return loaded;
  }
  function request(
    offer: MarketplaceOfferState,
    version: number,
    policy: Awaited<ReturnType<typeof load>>,
  ): ManagedOfferTargetRequest {
    return {
      selection: {
        ...policy.state.authority!.offers.find((selection) => selection.offerId === offer.offerId)!,
        offerVersion: version,
      },
      currency: policy.state.currency!,
      adjustmentBps: policy.state.authority!.adjustmentBps,
      policyRevision: policy.state.revision,
      evaluatedAt: new Date().toISOString(),
    };
  }
  async function evaluatePage(requests: readonly ManagedOfferTargetRequest[]) {
    if (!pricing) throw new ManagedOfferConflictError("managed_offer_held");
    const targets = await pricing.evaluateTargets(requests);
    if (targets.length !== requests.length) throw new ManagedOfferConflictError("managed_offer_held");
    return targets;
  }
  async function evaluate(offer: MarketplaceOfferState, version: number, policy: Awaited<ReturnType<typeof load>>) {
    return (await evaluatePage([request(offer, version, policy)]))[0]!;
  }
  function guard(policy: Awaited<ReturnType<typeof load>>, context: EventStoreContext) {
    return {
      streamId: `marketplace.offer-policy-${policy.state.policyId}`,
      expectedVersion: policy.version,
      events: [],
      context,
    };
  }
  function hasSameConsentRevision(policy: Awaited<ReturnType<typeof load>>, recordedVersion: number) {
    if (!Number.isInteger(recordedVersion) || recordedVersion < 1 || recordedVersion > policy.version) return false;
    // Complete aggregate events are ordered from stream version 1. Preview and
    // consumption move the stream fence, but do not grant a new consent revision.
    const authorized = policy.events
      .slice(0, recordedVersion)
      .reverse()
      .find((event) => event.type === "marketplace.offer-policy.authorized");
    return (
      authorized?.type === "marketplace.offer-policy.authorized" && authorized.data.revision === policy.state.revision
    );
  }
  async function acceptance(offer: MarketplaceOfferState, version: number, context: EventStoreContext) {
    try {
      const policy = await load(offer);
      const target = await evaluate(offer, version, policy);
      if (target.status === "held") throw new ManagedOfferConflictError("managed_offer_held");
      if (target.unitItemAmount !== offer.priceAmount)
        throw new ManagedOfferConflictError("managed_offer_refresh_required");
      const operationId = `accept_${offer.offerId}`;
      const consumption = consumeBuyerOfferCommitment(
        policy.state,
        offer,
        version,
        {
          schemaVersion: 1,
          policyId: policy.state.policyId!,
          buyerAccountId: offer.buyerAccountId!,
          actorUserId: context.audit.performedByUserId,
          operationId,
          requestHash: createHash("sha256")
            .update(JSON.stringify({ operationId, version, evidence: target.evidence }))
            .digest("hex"),
          recordedAt: new Date().toISOString(),
        },
        target.evidence,
      );
      return { policy, append: { ...guard(policy, context), events: [buyerOfferPolicyCodec.encode(consumption)] } };
    } catch (error) {
      if (error instanceof BuyerOfferPolicyError) throw new ManagedOfferConflictError("managed_offer_held");
      throw error;
    }
  }
  return { load, evaluate, evaluatePage, request, guard, acceptance, hasSameConsentRevision };
}
