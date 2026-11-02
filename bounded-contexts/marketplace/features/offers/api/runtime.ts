import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, CatalogItemId, OfferId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import { quoteMarketplaceTerms } from "../../../support/runtime-support/fee-quotes";
import type { MarketplaceListingTermsPreview } from "../../listings/ui/contracts";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../../listings/domain/domain";
import { evaluateListingEvidenceReadiness } from "../../listings/domain/listing-evidence-readiness";
import { resolveListingEvidenceRequirements } from "../../listings/api/evidence-requirement-resolver";
import { getMarketplaceAccountRisk } from "../../listings/read-model/queries";
import {
  decideSellerListingAvailability,
  evolveSellerListingAvailability,
  initialSellerListingAvailabilityState,
  type SellerListingAvailabilityEvent,
} from "../../listings/domain/seller-listing-availability";
import { buildListingEvidenceSnapshot, type ListingEvidenceSnapshot } from "../../listings/domain/evidence-snapshot";
import {
  decideMarketplaceOffer,
  decideManagedMarketplaceOffer,
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  normalizeOfferPriceCurrencyCode,
  offerLifecycleTransition,
  type MarketplaceOfferCommand,
  type MarketplaceOfferEvent,
  type MarketplaceOfferState,
  type OfferLifecycleAction,
  type OfferStatus,
} from "../domain/domain";
import { createOfferAcceptedCsatOutcomeFact } from "./request-support/customer-feedback-outcome-fact";
import { assertOfferSubmissionAllowed, MarketplaceOfferAbuseControlError } from "../domain/offer-abuse-policy";
import {
  decideMarketplaceOfferSellerControl,
  evolveMarketplaceOfferSellerControl,
  initialMarketplaceOfferSellerControlState,
  type MarketplaceOfferSellerControlCommand,
  type MarketplaceOfferSellerControlEvent,
  type MarketplaceOfferSellerControlState,
} from "../domain/offer-seller-controls";
import { buildMarketplaceOfferProjectionHandlers } from "../read-model/projection";
import {
  getPublicOffer,
  getSubmittedOffer,
  getOfferMatch,
  getOfferMatchForListing,
  listSubmittedOffers,
  listOfferMatches,
} from "../read-model/queries";
import { createMarketplaceProductDescriptor, type MarketplaceVersionSchema } from "../domain/versioning";
import { createManagedOfferAuthority, ManagedOfferConflictError, type ManagedOfferTarget } from "./managed-authority";
import { BuyerOfferPolicyError } from "../../offer-policy/domain/domain";
import { createMarketplaceAttempt } from "../../mutation-recovery/api/attempt";
import { offerAttemptResultSchema, offerAcceptanceResultSchema, offerPriceAttemptResultSchema } from "./attempt-result";
import { marketplaceRecoveryLoader } from "../../mutation-recovery/api/repository";
import { marketplaceOfferRecoveryCodec } from "../domain/recovery-codec";
import type { RepresentativeMarketplaceServices } from "@chase-sets/catalog-seed";
import { MarketplaceOfferLifecycleClosedError } from "./lifecycle-admission";

export class MarketplaceOfferFeeQuoteStaleError extends Error {
  public constructor(public readonly currentQuote: MarketplaceListingTermsPreview) {
    super("Fee quote is stale. Refresh the fee preview before continuing.");
    this.name = "MarketplaceOfferFeeQuoteStaleError";
  }
}

export { MarketplaceOfferAbuseControlError };

export class MarketplaceOfferAcceptanceReadinessError extends Error {
  public constructor(
    public readonly code:
      | "offer_already_accepted"
      | "offer_not_open"
      | "listing_not_eligible"
      | "listing_evidence_incomplete"
      | "listing_seller_trust_incomplete",
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(
      code === "offer_already_accepted"
        ? "Offer has already been accepted."
        : code === "offer_not_open"
          ? "Offer is not open for acceptance."
          : code === "listing_evidence_incomplete"
            ? "Listing Evidence requirements are incomplete."
            : code === "listing_seller_trust_incomplete"
              ? "Seller trust requirements are incomplete for this Listing."
              : "The selected Listing is no longer eligible for this Offer.",
    );
    this.name = "MarketplaceOfferAcceptanceReadinessError";
  }
}

export class MarketplaceOfferLifecycleError extends Error {
  public constructor(public readonly code: "not_found" | "offer_transition_rejected" | "offer_conflict") {
    super(
      code === "not_found"
        ? "Offer not found."
        : code === "offer_conflict"
          ? "Offer changed while this request was running."
          : "Offer cannot make this lifecycle change.",
    );
    this.name = "MarketplaceOfferLifecycleError";
  }
}

export const MARKETPLACE_OFFER_BULK_LIFECYCLE_LIMIT = 250;

export type MarketplaceOfferLifecycleResult = Readonly<{
  offerId: OfferId;
  outcome: "changed" | "unchanged";
  status: OfferStatus;
  version: number;
}>;

export type MarketplaceOfferLifecycleOutcome =
  | MarketplaceOfferLifecycleResult
  | Readonly<{ offerId: OfferId; outcome: "rejected"; code: MarketplaceOfferLifecycleError["code"] }>;

const offerLifecycleCommandTypes = {
  pause: "PauseOffer",
  resume: "ResumeOffer",
  withdraw: "WithdrawOffer",
} as const satisfies Record<OfferLifecycleAction, MarketplaceOfferCommand["type"]>;

export type MarketplaceOfferAcceptanceResult = Readonly<{
  offerId: OfferId;
  listingId: string;
  inventoryItemId: string;
  listingEvidenceSnapshot: ListingEvidenceSnapshot;
  version: number;
}>;

export type MarketplaceOfferServices = Readonly<{
  applyManagedOfferPage: (
    items: readonly { offerId: OfferId; operationId: string }[],
    context: EventStoreContext,
    workGuard: AppendToStreamInput,
  ) => Promise<void>;
  applyManagedOffer: (
    offerId: OfferId,
    operationId: string,
    context: EventStoreContext,
    workGuard?: AppendToStreamInput,
  ) => Promise<{ status: "applied" | "held" | "unchanged"; version: number }>;
  commandHandler: CommandHandler<MarketplaceOfferCommand, MarketplaceOfferState, MarketplaceOfferEvent>;
  sellerControlCommandHandler: CommandHandler<
    MarketplaceOfferSellerControlCommand,
    MarketplaceOfferSellerControlState,
    MarketplaceOfferSellerControlEvent
  >;
  submitOffer: (
    params: Parameters<RepresentativeMarketplaceServices["offers"]["submitOffer"]>[0],
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  updateOfferPrice: (
    params: Readonly<{
      attemptId: string;
      requestHash?: string;
      offerId: OfferId;
      buyerAccountId: AccountId;
      priceAmount: string;
      priceCurrencyCode: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number; status: OfferStatus }>;
  changeOfferLifecycle: (
    params: Readonly<{ offerId: OfferId; buyerAccountId: AccountId; action: OfferLifecycleAction }>,
    context: EventStoreContext,
  ) => Promise<MarketplaceOfferLifecycleResult>;
  bulkChangeOfferLifecycle: (
    params: Readonly<{ buyerAccountId: AccountId; action: OfferLifecycleAction; offerIds: readonly OfferId[] }>,
    context: EventStoreContext,
  ) => Promise<readonly MarketplaceOfferLifecycleOutcome[]>;
  acceptOffer: (
    params: Parameters<RepresentativeMarketplaceServices["offers"]["acceptOffer"]>[0],
    context: EventStoreContext,
  ) => Promise<MarketplaceOfferAcceptanceResult>;
  declineOfferMatch: (
    params: Readonly<{
      attemptId: string;
      requestHash?: string;
      offerId: OfferId;
      sellerAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  previewOfferAcceptanceTerms: (
    params: Readonly<{
      offerId: OfferId;
      sellerAccountId: AccountId;
      listingId: string;
    }>,
  ) => Promise<MarketplaceListingTermsPreview>;
  listSubmittedOffers: (params: Parameters<typeof listSubmittedOffers>[1]) => ReturnType<typeof listSubmittedOffers>;
  getSubmittedOffer: (offerId: string, buyerAccountId: string) => ReturnType<typeof getSubmittedOffer>;
  getPublicOffer: (offerId: string) => ReturnType<typeof getPublicOffer>;
  listOfferMatches: (params: Parameters<typeof listOfferMatches>[1]) => ReturnType<typeof listOfferMatches>;
  getOfferMatch: (offerId: string, sellerAccountId: string) => ReturnType<typeof getOfferMatch>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createMarketplaceOfferRuntime(deps: MarketplaceRuntimeDeps): MarketplaceOfferServices {
  const managed = createManagedOfferAuthority(deps.eventStore, deps.managedOfferPricing);
  const offerCodec = createPassthroughDomainEventCodec<MarketplaceOfferEvent>();
  const listingCodec = createPassthroughDomainEventCodec<MarketplaceListingEvent>();
  const sellerAvailabilityCodec = createPassthroughDomainEventCodec<SellerListingAvailabilityEvent>();
  const { commandHandler, repository: offerRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: offerCodec,
    initialState: () => initialMarketplaceOfferState,
    evolve: evolveMarketplaceOffer,
    decide: decideMarketplaceOffer,
  });
  const { commandHandler: sellerControlCommandHandler, repository: controlRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceOfferSellerControlEvent>(),
    initialState: () => initialMarketplaceOfferSellerControlState,
    evolve: evolveMarketplaceOfferSellerControl,
    decide: decideMarketplaceOfferSellerControl,
  });
  const { repository: rawListingRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: listingCodec,
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });
  const { repository: rawSellerAvailabilityRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: sellerAvailabilityCodec,
    initialState: () => initialSellerListingAvailabilityState,
    evolve: evolveSellerListingAvailability,
    decide: decideSellerListingAvailability,
  });
  const repository = {
    ...offerRepository,
    load: marketplaceRecoveryLoader(
      deps.eventStore,
      initialMarketplaceOfferState,
      marketplaceOfferRecoveryCodec,
      evolveMarketplaceOffer,
    ),
  };
  const sellerControlRepository = {
    ...controlRepository,
    load: marketplaceRecoveryLoader(
      deps.eventStore,
      initialMarketplaceOfferSellerControlState,
      createPassthroughDomainEventCodec<MarketplaceOfferSellerControlEvent>(),
      evolveMarketplaceOfferSellerControl,
    ),
  };
  const listingRepository = {
    ...rawListingRepository,
    load: marketplaceRecoveryLoader(
      deps.eventStore,
      initialMarketplaceListingState,
      listingCodec,
      evolveMarketplaceListing,
    ),
  };
  const sellerAvailabilityRepository = {
    ...rawSellerAvailabilityRepository,
    load: marketplaceRecoveryLoader(
      deps.eventStore,
      initialSellerListingAvailabilityState,
      sellerAvailabilityCodec,
      evolveSellerListingAvailability,
    ),
  };

  async function getCatalogItemSnapshot(catalogItemId: string) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      title: string;
      subtitle: string | null;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, title, subtitle, status, product_schema
       FROM marketplace_catalog_items
       WHERE catalog_item_id = $1`,
      [catalogItemId],
    );

    return result.rows[0] ?? null;
  }

  async function findOwnActiveListingForProduct(buyerAccountId: AccountId, productId: string) {
    const result = await deps.db.query<{ account_id: string }>(
      `SELECT account_id
       FROM marketplace_listing_pages
       WHERE account_id = $1
         AND product_id = $2
         AND status = 'active'
       LIMIT 1`,
      [buyerAccountId, productId],
    );

    return result.rows[0]?.account_id ?? null;
  }

  async function loadSubmissionGuard(buyerAccountId: AccountId) {
    const dailyWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const buyerCountResult = await deps.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_offer_pages
       WHERE buyer_account_id = $1
         AND created_at >= $2`,
      [buyerAccountId, dailyWindowStart],
    );
    assertOfferSubmissionAllowed({
      buyerDailySubmissionCount: Number(buyerCountResult.rows[0]?.count ?? 0),
    });
  }

  async function quoteOfferAcceptanceTerms(offerId: OfferId, sellerAccountId: AccountId, listingId: string) {
    const offer = await getOfferMatchForListing(deps.db, offerId, sellerAccountId, listingId);
    if (!offer) {
      throw new Error("Offer not found.");
    }

    const current = await repository.load(`marketplace.offer-${offerId}`);
    const quote = await quoteMarketplaceTerms(deps.commercialTermsResolver, {
      accountId: sellerAccountId,
      priceAmount: current.state.buyerOfferPolicyId ? current.state.priceAmount! : offer.price_amount,
    });
    if (!current.state.buyerOfferPolicyId) return quote;
    const listing = await listingRepository.load(`marketplace.listing-${listingId}`);
    return {
      ...quote,
      fee_quote_fingerprint: `${quote.fee_quote_fingerprint}|${offerId}:${current.version}|${listingId}:${listing.version}`,
    };
  }

  async function assertOfferLifecycleAdmitted() {
    const decision = deps.offerLifecycleAdmission
      ? await deps.offerLifecycleAdmission.check()
      : ({ admitted: false, reason: "admission_not_configured" } as const);
    if (!decision.admitted) throw new MarketplaceOfferLifecycleClosedError(decision.reason);
  }

  async function changeOfferLifecycle(
    params: Readonly<{ offerId: OfferId; buyerAccountId: AccountId; action: OfferLifecycleAction }>,
    context: EventStoreContext,
  ): Promise<MarketplaceOfferLifecycleResult> {
    const streamId = `marketplace.offer-${params.offerId}`;
    const classify = (state: MarketplaceOfferState) => {
      // Another buyer's Offer is indistinguishable from a missing one.
      if (state.offerId === null || state.buyerAccountId !== params.buyerAccountId)
        return new MarketplaceOfferLifecycleError("not_found");
      return offerLifecycleTransition(state.status, params.action) === "rejected"
        ? new MarketplaceOfferLifecycleError("offer_transition_rejected")
        : null;
    };
    const current = await repository.load(streamId);
    const rejection = classify(current.state);
    if (rejection) throw rejection;
    try {
      const result = await commandHandler({
        streamId,
        expectedVersion: current.version,
        command: {
          type: offerLifecycleCommandTypes[params.action],
          buyerAccountId: params.buyerAccountId,
          at: new Date().toISOString(),
        },
        context,
      });
      return {
        offerId: params.offerId,
        outcome: result.newEvents.length > 0 ? "changed" : "unchanged",
        status: result.state.status,
        version: result.version,
      };
    } catch (error) {
      // A concurrent change can land between the check above and the decision or append.
      const latest = classify((await repository.load(streamId)).state);
      if (latest) throw latest;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict")
        throw new MarketplaceOfferLifecycleError("offer_conflict");
      throw error;
    }
  }

  function assertConfirmedFeeQuote(
    providedFingerprint: string | null | undefined,
    currentQuote: MarketplaceListingTermsPreview,
  ) {
    if (providedFingerprint !== currentQuote.fee_quote_fingerprint) {
      throw new MarketplaceOfferFeeQuoteStaleError(currentQuote);
    }
  }

  async function applyManagedOffer(
    offerId: OfferId,
    operationId: string,
    context: EventStoreContext,
    workGuard?: AppendToStreamInput,
    prepared?: {
      current: Awaited<ReturnType<typeof repository.load>>;
      policy: Awaited<ReturnType<typeof managed.load>>;
      target: ManagedOfferTarget;
    },
  ): Promise<{ status: "applied" | "held" | "unchanged"; version: number }> {
    const current = prepared?.current ?? (await repository.load(`marketplace.offer-${offerId}`));
    if (current.state.status !== "submitted" || !current.state.buyerOfferPolicyId)
      return { status: "unchanged", version: current.version };
    const prior = current.events.find(
      (event) => event.type === "marketplace.offer.managed-evaluated" && event.data.operationId === operationId,
    );
    if (prior?.type === "marketplace.offer.managed-evaluated")
      return { status: prior.data.status, version: current.version };
    const policy = prepared?.policy ?? (await managed.load(current.state));
    const target = prepared?.target ?? (await managed.evaluate(current.state, current.version, policy));
    if (target.status === "target" && target.unitItemAmount === current.state.priceAmount)
      return { status: "unchanged", version: current.version };
    const last = current.events.at(-1);
    if (
      target.status === "held" &&
      last?.type === "marketplace.offer.managed-evaluated" &&
      last.data.status === "held" &&
      last.data.policyId === policy.state.policyId &&
      last.data.reason === target.reason &&
      managed.hasSameConsentRevision(policy, last.data.policyVersion)
    )
      return { status: "held", version: current.version };
    const events: MarketplaceOfferEvent[] =
      target.status === "target"
        ? [
            ...decideManagedMarketplaceOffer(
              current.state,
              {
                type: "UpdateOfferPrice",
                buyerAccountId: current.state.buyerAccountId!,
                priceAmount: target.unitItemAmount,
                priceCurrencyCode: policy.state.currency!,
              },
              policy.state,
            ),
          ]
        : [];
    events.push({
      type: "marketplace.offer.managed-evaluated",
      data: {
        offerId,
        policyId: policy.state.policyId!,
        policyVersion: policy.version,
        operationId,
        status: target.status === "target" ? "applied" : "held",
        reason: target.status === "held" ? target.reason : "market-price-target",
        evidence: target.evidence,
      },
    });
    if (!deps.eventStore.appendToStreams) throw new Error("Managed Offers require atomic multi-stream append support.");
    try {
      await deps.eventStore.appendToStreams([
        managed.guard(policy, context),
        {
          streamId: `marketplace.offer-${offerId}`,
          expectedVersion: current.version,
          events: events.map(offerCodec.encode),
          context,
        },
        ...(workGuard ? [workGuard] : []),
      ]);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict")
        throw new ManagedOfferConflictError("managed_offer_conflict");
      throw error;
    }
    return { status: target.status === "target" ? "applied" : "held", version: current.version + events.length };
  }
  return {
    applyManagedOffer,
    applyManagedOfferPage: async (items, context, workGuard) => {
      if (items.length > 100) throw new Error("Managed Offer work pages are bounded to 100 Offers.");
      const prepared = [];
      for (const item of items) {
        const current = await repository.load(`marketplace.offer-${item.offerId}`);
        if (
          current.state.status !== "submitted" ||
          !current.state.buyerOfferPolicyId ||
          current.events.some(
            (event) =>
              event.type === "marketplace.offer.managed-evaluated" && event.data.operationId === item.operationId,
          )
        )
          continue;
        try {
          prepared.push({ item, current, policy: await managed.load(current.state) });
        } catch (error) {
          if (!(error instanceof BuyerOfferPolicyError)) throw error;
        }
      }
      if (prepared.length === 0) return;
      const targets = await managed.evaluatePage(
        prepared.map(({ current, policy }) => managed.request(current.state, current.version, policy)),
      );
      for (const [index, entry] of prepared.entries())
        await applyManagedOffer(entry.item.offerId, entry.item.operationId, context, workGuard, {
          ...entry,
          target: targets[index]!,
        });
    },
    commandHandler,
    sellerControlCommandHandler,
    submitOffer: async (params, context) => {
      const { attemptId, requestHash, ...request } = params;
      if (context.audit.forAccountId !== params.buyerAccountId) throw new Error("Offer actor account mismatch.");
      const attempt = createMarketplaceAttempt(
        deps.eventStore,
        {
          attemptId,
          requestHash,
          request,
          mutationKind: "offer.submit",
          accountId: params.buyerAccountId,
          target: { kind: "product", id: params.productId },
        },
        offerAttemptResultSchema,
      );
      const first = await attempt.read();
      if (first) return first;
      const priceCurrencyCode = normalizeOfferPriceCurrencyCode(params.priceCurrencyCode);
      const catalogItem = await getCatalogItemSnapshot(params.catalogItemId);
      if (!catalogItem) {
        throw new Error("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new Error("Offers may only reference active catalog items.");
      }

      const catalogVersion = createMarketplaceProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema:
          typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
            ? (catalogItem.product_schema as MarketplaceVersionSchema)
            : null,
        selection: params.selectedOptions,
      });

      if (params.productId.trim() !== catalogVersion.productId) {
        throw new Error("Offer product id does not match the selected options.");
      }
      const ownSellerAccountId = await findOwnActiveListingForProduct(params.buyerAccountId, catalogVersion.productId);
      if (ownSellerAccountId) {
        throw new Error("Accounts cannot offer on their own listings.");
      }
      await loadSubmissionGuard(params.buyerAccountId);

      const offerId = params.offerId ?? (createId("off") as OfferId);
      const current = await repository.load(`marketplace.offer-${offerId}`);
      const events = decideMarketplaceOffer(current.state, {
        type: "SubmitOffer",
        offerId,
        buyerAccountId: params.buyerAccountId,
        sellerAccountId: null,
        catalogItemId: params.catalogItemId as CatalogItemId,
        productId: catalogVersion.productId,
        itemTitle: params.itemTitle,
        itemSubtitle: params.itemSubtitle,
        selectedOptions: catalogVersion.selection,
        productSummary: params.productSummary,
        shippingDestinationSnapshot: params.shippingDestinationSnapshot,
        priceAmount: params.priceAmount,
        priceCurrencyCode,
        quantityRequested: params.quantityRequested,
      });
      const result = { offerId, version: current.version + events.length };
      return attempt.commit(
        [
          {
            streamId: `marketplace.offer-${offerId}`,
            expectedVersion: current.version,
            events: events.map(offerCodec.encode),
            context,
          },
        ],
        result,
        { id: offerId, version: result.version },
        context,
      );
    },
    updateOfferPrice: async (params, context) => {
      const { attemptId, requestHash, ...request } = params;
      if (context.audit.forAccountId !== params.buyerAccountId) throw new Error("Offer actor account mismatch.");
      const attempt = createMarketplaceAttempt(
        deps.eventStore,
        {
          attemptId,
          requestHash,
          request,
          mutationKind: "offer.update-price",
          accountId: params.buyerAccountId,
          target: { kind: "offer", id: params.offerId },
        },
        offerPriceAttemptResultSchema,
      );
      const first = await attempt.read();
      if (first) return first;
      const current = await repository.load(`marketplace.offer-${params.offerId}`);
      if (current.state.buyerOfferPolicyId) {
        const policy = await managed.load(current.state);
        const events = [
          ...decideManagedMarketplaceOffer(current.state, { type: "UpdateOfferPrice", ...params }, policy.state),
        ];
        if (events.length > 0)
          events.push({
            type: "marketplace.offer.managed-evaluated",
            data: {
              offerId: params.offerId,
              policyId: policy.state.policyId!,
              policyVersion: policy.version,
              operationId: `manual_${params.offerId}_${current.version}`,
              status: "applied",
              reason: "buyer-price-edit",
              evidence: {
                policyRevision: policy.state.revision,
                offerVersion: current.version,
                priceAmount: params.priceAmount,
                currency: policy.state.currency!,
              },
            },
          });
        if (!deps.eventStore.appendToStreams)
          throw new Error("Managed Offers require atomic multi-stream append support.");
        try {
          return await attempt.commit(
            [
              managed.guard(policy, context),
              {
                streamId: `marketplace.offer-${params.offerId}`,
                expectedVersion: current.version,
                events: events.map(offerCodec.encode),
                context,
              },
            ],
            { offerId: params.offerId, version: current.version + events.length, status: current.state.status },
            { id: params.offerId, version: current.version + events.length },
            context,
          );
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict")
            throw new ManagedOfferConflictError("managed_offer_conflict");
          throw error;
        }
      }
      const events = decideMarketplaceOffer(current.state, {
        type: "UpdateOfferPrice",
        buyerAccountId: params.buyerAccountId,
        priceAmount: params.priceAmount,
        priceCurrencyCode: params.priceCurrencyCode,
      });
      const result = {
        offerId: params.offerId,
        version: current.version + events.length,
        status: current.state.status,
      };
      return attempt.commit(
        [
          {
            streamId: `marketplace.offer-${params.offerId}`,
            expectedVersion: current.version,
            events: events.map(offerCodec.encode),
            context,
          },
        ],
        result,
        { id: params.offerId, version: result.version },
        context,
      );
    },
    changeOfferLifecycle: async (params, context) => {
      await assertOfferLifecycleAdmitted();
      return changeOfferLifecycle(params, context);
    },
    bulkChangeOfferLifecycle: async (params, context) => {
      if (params.offerIds.length === 0 || params.offerIds.length > MARKETPLACE_OFFER_BULK_LIFECYCLE_LIMIT)
        throw new Error(`Bulk Offer changes take 1 to ${MARKETPLACE_OFFER_BULK_LIFECYCLE_LIMIT} Offers.`);
      await assertOfferLifecycleAdmitted();
      const outcomes: MarketplaceOfferLifecycleOutcome[] = [];
      for (const offerId of params.offerIds) {
        try {
          outcomes.push(
            await changeOfferLifecycle(
              { offerId, buyerAccountId: params.buyerAccountId, action: params.action },
              context,
            ),
          );
        } catch (error) {
          if (!(error instanceof MarketplaceOfferLifecycleError)) throw error;
          outcomes.push({ offerId, outcome: "rejected", code: error.code });
        }
      }
      return outcomes;
    },
    declineOfferMatch: async (params, context) => {
      const { attemptId, requestHash, ...request } = params;
      if (context.audit.forAccountId !== params.sellerAccountId) throw new Error("Offer actor account mismatch.");
      const attempt = createMarketplaceAttempt(
        deps.eventStore,
        {
          attemptId,
          requestHash,
          request,
          mutationKind: "offer.decline",
          accountId: params.sellerAccountId,
          target: { kind: "offer", id: params.offerId },
        },
        offerAttemptResultSchema,
      );
      const first = await attempt.read();
      if (first) return first;
      const offer = await getOfferMatch(deps.db, params.offerId, params.sellerAccountId);
      if (!offer) {
        throw new Error("Offer not found.");
      }
      const streamId = `marketplace.offer-seller-control-${params.sellerAccountId}-${offer.buyer_account_id}-${offer.listing_id}`;
      const current = await sellerControlRepository.load(streamId);
      const events = decideMarketplaceOfferSellerControl(current.state, {
        type: "DeclineOfferMatch",
        sellerAccountId: params.sellerAccountId,
        buyerAccountId: offer.buyer_account_id as AccountId,
        listingId: offer.listing_id,
        productId: offer.product_id,
        offerId: params.offerId,
        offerPriceAmount: offer.price_amount,
        offerPriceCurrencyCode: offer.price_currency_code!,
        listingPriceAmount: offer.listing_price_amount,
        listingPriceCurrencyCode: offer.listing_price_currency_code,
        declinedAt: new Date().toISOString(),
      });
      const result = { offerId: params.offerId, version: current.version + events.length };
      return attempt.commit(
        [
          {
            streamId,
            expectedVersion: current.version,
            events: events.map(createPassthroughDomainEventCodec<MarketplaceOfferSellerControlEvent>().encode),
            context,
          },
        ],
        result,
        { id: params.offerId, version: result.version },
        context,
      );
    },
    previewOfferAcceptanceTerms: async (params) =>
      quoteOfferAcceptanceTerms(params.offerId, params.sellerAccountId, params.listingId),
    acceptOffer: async (params, context) => {
      const { sourceActionKey, requestHash, ...request } = params;
      if (context.audit.forAccountId !== params.sellerAccountId) throw new Error("Offer actor account mismatch.");
      const attempt = createMarketplaceAttempt(
        deps.eventStore,
        {
          attemptId: sourceActionKey,
          requestHash,
          request,
          mutationKind: "offer.accept",
          accountId: params.sellerAccountId,
          target: { kind: "offer", id: params.offerId },
        },
        offerAcceptanceResultSchema,
      );
      const first = await attempt.read();
      if (first) return first;
      const offerStreamId = `marketplace.offer-${params.offerId}`;
      const current = await repository.load(offerStreamId);
      if (current.state.status === "accepted") {
        if (
          current.state.acceptedSellerAccountId === params.sellerAccountId &&
          current.state.acceptedListingId === params.listingId &&
          current.state.acceptedInventoryItemId &&
          current.state.listingEvidenceSnapshot
        ) {
          return {
            offerId: params.offerId,
            listingId: current.state.acceptedListingId,
            inventoryItemId: current.state.acceptedInventoryItemId,
            listingEvidenceSnapshot: current.state.listingEvidenceSnapshot,
            version: current.version,
          };
        }
        throw new MarketplaceOfferAcceptanceReadinessError("offer_already_accepted", {
          acceptedSellerAccountId: current.state.acceptedSellerAccountId,
          acceptedListingId: current.state.acceptedListingId,
        });
      }

      if (current.state.status !== "submitted") {
        throw new MarketplaceOfferAcceptanceReadinessError("offer_not_open", { status: current.state.status });
      }

      const buyerAccount = await deps.db.query<{ account_status: string }>(
        `SELECT status AS account_status FROM marketplace_account_pages WHERE account_id = $1`,
        [current.state.buyerAccountId],
      );
      if (buyerAccount.rows[0]?.account_status !== "active") {
        throw new MarketplaceOfferAcceptanceReadinessError("offer_not_open", {
          status: current.state.status,
        });
      }

      const listingStreamId = `marketplace.listing-${params.listingId}`;
      const managedAcceptance = current.state.buyerOfferPolicyId
        ? await managed.acceptance(current.state, current.version, context)
        : null;
      const availabilityStreamId = `marketplace.seller-listing-availability-${params.sellerAccountId}`;
      const [offer, listing, sellerAvailability] = await Promise.all([
        getOfferMatchForListing(deps.db, params.offerId, params.sellerAccountId, params.listingId),
        listingRepository.load(listingStreamId),
        sellerAvailabilityRepository.load(availabilityStreamId),
      ]);

      if (!offer) {
        throw new MarketplaceOfferAcceptanceReadinessError("listing_not_eligible", { listingId: params.listingId });
      }
      if (current.state.buyerAccountId === params.sellerAccountId) {
        throw new Error("Accounts cannot accept their own offers.");
      }
      if (sellerAvailability.state.status === "unavailable") {
        throw new Error("Seller listing availability is off.");
      }
      const exactListing = listing.state;
      if (
        exactListing.listingId !== params.listingId ||
        exactListing.accountId !== params.sellerAccountId ||
        exactListing.publicationScope === "channel-only" ||
        exactListing.status !== "active" ||
        !exactListing.productId ||
        !exactListing.catalogItemId ||
        !exactListing.priceAmount ||
        !exactListing.priceCurrencyCode ||
        !current.state.priceCurrencyCode ||
        exactListing.priceCurrencyCode !== current.state.priceCurrencyCode ||
        exactListing.productId !== current.state.productId ||
        exactListing.catalogItemId !== current.state.catalogItemId
      ) {
        throw new MarketplaceOfferAcceptanceReadinessError("listing_not_eligible", { listingId: params.listingId });
      }
      if (!exactListing.inventoryItemId || !offer.can_fulfill) {
        throw new Error("Seller does not have enough active supply to accept this offer.");
      }
      const inventoryItemId = exactListing.inventoryItemId;
      const acceptedAt = new Date().toISOString();
      let evidenceRequirements;
      try {
        evidenceRequirements = await resolveListingEvidenceRequirements(deps, {
          accountId: params.sellerAccountId,
          catalogItemId: exactListing.catalogItemId,
          productId: exactListing.productId,
          selectedOptions: exactListing.selectedOptions,
          gradedItem: exactListing.gradedCard !== null,
          priceAmount: exactListing.priceAmount,
          evaluatedAt: acceptedAt,
        });
      } catch {
        throw new Error("Listing evidence requirements are unavailable.");
      }
      const requiresSellerFacts = evidenceRequirements.requirements.sellerTrustRequirements.length > 0;
      const accountRisk = requiresSellerFacts
        ? await getMarketplaceAccountRisk(deps.db, params.sellerAccountId)
        : { review_count: 0, badges: [] as readonly string[] };
      const readiness = evaluateListingEvidenceReadiness({
        snapshot: evidenceRequirements,
        evidence: exactListing.evidence,
        seller: { reviewCount: accountRisk.review_count, badgeKeys: accountRisk.badges },
        now: acceptedAt,
      });
      if (!readiness.ready) {
        const code = readiness.unmetCodes.includes("seller-trust-requirement-unmet")
          ? "listing_seller_trust_incomplete"
          : "listing_evidence_incomplete";
        throw new MarketplaceOfferAcceptanceReadinessError(code, {
          listingId: params.listingId,
          unmetCodes: readiness.unmetCodes,
        });
      }
      const requirementEvents = decideMarketplaceListing(exactListing, {
        type: "RefreshListingEvidenceRequirements",
        evidenceRequirements,
      });
      const listingEvidenceSnapshot = buildListingEvidenceSnapshot({
        evidence: exactListing.evidence,
        policyHash: evidenceRequirements.policyHash,
        createdAt: acceptedAt,
      });
      const quote = await quoteMarketplaceTerms(deps.commercialTermsResolver, {
        accountId: params.sellerAccountId,
        priceAmount: String(current.state.priceAmount),
      });
      const confirmedQuote = managedAcceptance
        ? {
            ...quote,
            fee_quote_fingerprint: `${quote.fee_quote_fingerprint}|${params.offerId}:${current.version}|${params.listingId}:${listing.version}`,
          }
        : quote;
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, confirmedQuote);
      const acceptCommand = {
        type: "AcceptOffer",
        sellerAccountId: params.sellerAccountId,
        listingId: params.listingId,
        inventoryItemId,
        listingVersion: listing.version + requirementEvents.length,
        listingEvidencePolicyId: evidenceRequirements.policyId,
        listingEvidencePolicyVersion: evidenceRequirements.policyVersion,
        listingEvidencePolicyHash: evidenceRequirements.policyHash,
        listingEvidenceSnapshot,
        acceptedAt,
        csatOutcomeFact: createOfferAcceptedCsatOutcomeFact({
          sellerAccountId: params.sellerAccountId,
          offerId: params.offerId,
          acceptedAt,
        }),
        marketplaceSalesFeePercentageBps: quote.marketplace_sales_fee_percentage_bps,
        marketplaceSalesFeeFixedAmount: quote.marketplace_sales_fee_fixed_amount,
        marketplaceSalesFeeCapAmount: quote.marketplace_sales_fee_cap_amount,
        marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
        sellerNetUnitAmount: quote.seller_net_unit_amount,
        shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
        termsScheduleId: quote.schedule_id,
        termsAgreementId: quote.agreement_id,
        termsResolvedAt: quote.resolved_at,
        feeQuoteFingerprint: confirmedQuote.fee_quote_fingerprint,
        acceptanceBatchId: params.acceptanceBatchId ?? null,
        acceptanceBatchSize: params.acceptanceBatchSize ?? null,
      } as const;
      const [acceptedEvent] = managedAcceptance
        ? decideManagedMarketplaceOffer(current.state, acceptCommand, managedAcceptance.policy.state)
        : decideMarketplaceOffer(current.state, acceptCommand);
      if (!acceptedEvent || acceptedEvent.type !== "marketplace.offer.accepted") {
        throw new Error("Offer acceptance did not produce a commitment fact.");
      }
      const listingCommitmentEvent: MarketplaceListingEvent = {
        type: "marketplace.listing.offer-commitment-recorded",
        data: {
          offerId: params.offerId,
          quantity: current.state.quantityRequested,
          evidenceSnapshotHash: listingEvidenceSnapshot.snapshotHash,
          committedAt: acceptedAt,
        },
      };
      const availabilityCheckEvent: SellerListingAvailabilityEvent = {
        type: "marketplace.seller-listing-availability.commitment-checked",
        data: { offerId: params.offerId, listingId: params.listingId, checkedAt: acceptedAt },
      };
      const appendToStreams = deps.eventStore.appendToStreams;
      if (!appendToStreams) {
        throw new Error("Offer acceptance requires atomic multi-stream append support.");
      }

      try {
        return await attempt.commit(
          [
            ...(managedAcceptance ? [managedAcceptance.append] : []),
            {
              streamId: offerStreamId,
              expectedVersion: current.version,
              events: [offerCodec.encode(acceptedEvent)],
              context,
            },
            {
              streamId: listingStreamId,
              expectedVersion: listing.version,
              events: [...requirementEvents, listingCommitmentEvent].map((event) => listingCodec.encode(event)),
              context,
            },
            {
              streamId: availabilityStreamId,
              expectedVersion: sellerAvailability.version === 0 ? "no_stream" : sellerAvailability.version,
              events: [sellerAvailabilityCodec.encode(availabilityCheckEvent)],
              context,
            },
          ],
          {
            offerId: params.offerId,
            listingId: params.listingId,
            inventoryItemId,
            listingEvidenceSnapshot,
            version: current.version + 1,
          },
          { id: params.offerId, version: current.version + 1 },
          context,
        );
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict") {
          const latest = await repository.load(offerStreamId);
          if (
            latest.state.acceptedSellerAccountId === params.sellerAccountId &&
            latest.state.acceptedListingId === params.listingId &&
            latest.state.acceptedInventoryItemId &&
            latest.state.listingEvidenceSnapshot
          ) {
            return {
              offerId: params.offerId,
              listingId: latest.state.acceptedListingId,
              inventoryItemId: latest.state.acceptedInventoryItemId,
              listingEvidenceSnapshot: latest.state.listingEvidenceSnapshot,
              version: latest.version,
            };
          }
          if (latest.state.status !== "submitted" && latest.state.status !== "accepted") {
            throw new MarketplaceOfferAcceptanceReadinessError("offer_not_open", { status: latest.state.status });
          }
          if (managedAcceptance) throw new ManagedOfferConflictError("managed_offer_conflict");
          throw new MarketplaceOfferAcceptanceReadinessError(
            latest.state.status === "accepted" ? "offer_already_accepted" : "listing_not_eligible",
            { listingId: params.listingId },
          );
        }
        throw error;
      }
    },
    listSubmittedOffers: (params) => listSubmittedOffers(deps.db, params),
    getSubmittedOffer: (offerId, buyerAccountId) => getSubmittedOffer(deps.db, offerId, buyerAccountId),
    getPublicOffer: (offerId) => getPublicOffer(deps.db, offerId),
    listOfferMatches: (params) => listOfferMatches(deps.db, params),
    getOfferMatch: (offerId, sellerAccountId) => getOfferMatch(deps.db, offerId, sellerAccountId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-offer-projection",
        handlers: buildMarketplaceOfferProjectionHandlers(deps.db),
      }),
    ],
  };
}
