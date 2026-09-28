import { isDeepStrictEqual } from "node:util";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  ListingAuthorityConsumerPort,
  ListingAuthorityOperation,
  ListingAuthorityParticipantPort,
  ListingAuthorityReservation,
  ListingAuthoritySessionAuthorityPort,
} from "@chase-sets/event-core/listing-authority";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogListingAuthorityFacts } from "@chase-sets/product-measures";
import { toJsonValue } from "@chase-sets/primitives/json";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import { createListingAuthorityRecovery } from "@chase-sets/platform-runtime/listing-authority-recovery";
import { prepareListingSessionAuthority } from "@chase-sets/platform-runtime/listing-authority-fence";
import { initialMarketplaceListingState, evolveMarketplaceListing } from "../domain/domain";
import { marketplaceListingCodec } from "../domain/codec";
import {
  initialSellerListingAvailabilityState,
  evolveSellerListingAvailability,
  type SellerListingAvailabilityEvent,
} from "../domain/seller-listing-availability";
import { evaluateListingEvidencePolicy } from "../../listing-evidence-policy/domain/policy";
import { createListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";
import { evaluateListingEvidenceReadiness } from "../domain/listing-evidence-readiness";
import type { ListingAuthorityResult, ListingNativeReadinessAuthority } from "./target-contracts";
import { createNativeAuthorityFacts, nativeAuthorityResources as resource } from "./native-authority-facts";

export type MarketplaceListingAuthorityPorts = Readonly<{
  consumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
  /** Required for session-authenticated final readiness/commitment operations. */
  session?: ListingAuthoritySessionAuthorityPort;
  identity?: Readonly<{
    participant: ListingAuthorityParticipantPort;
    /** Identity's owner API supplies badges from the same retained account reservation. */
    sellerFacts(reservation: ListingAuthorityReservation): Readonly<{ badgeKeys: readonly string[] }>;
  }>;
  catalog?: Readonly<{
    participant: ListingAuthorityParticipantPort;
    readFacts(operation: ListingAuthorityOperation): Promise<CatalogListingAuthorityFacts>;
  }>;
  inventory?: ListingAuthorityParticipantPort;
}>;

export function createMarketplaceListingAuthority(
  deps: Readonly<{ eventStore: EventStore; db: PgQueryable; now?: () => Date }>,
  ports: MarketplaceListingAuthorityPorts,
) {
  const facts = createNativeAuthorityFacts(deps.eventStore, deps.db);
  const resources = (operation: ListingAuthorityOperation) => [
    resource.listing(operation.listingId),
    resource.availability(operation.accountId),
    resource.reviews(operation.accountId),
    resource.policy,
  ];

  async function validate(operation: ListingAuthorityOperation, context: EventStoreContext, commitment: boolean) {
    if (operation.target.kind !== "native-marketplace" || !operation.subject.pair)
      throw new Error("Native authority requires an exact native pair.");
    const { identity, catalog } = ports;
    if (
      !identity ||
      !catalog ||
      identity.participant.participant.owner !== "identity" ||
      identity.participant.participant.purpose !== "manage-listing" ||
      catalog.participant.participant.owner !== "catalog" ||
      catalog.participant.participant.purpose !== "product-measures"
    )
      throw new Error("Native upstream authority is not mounted.");
    const listingStream = `marketplace.listing-${operation.listingId}`;
    const listingHistory = await readCompleteStream(deps.eventStore, { streamId: listingStream });
    const listing = listingHistory.reduce(
      (state, event) => evolveMarketplaceListing(state, marketplaceListingCodec.decode(event)),
      initialMarketplaceListingState,
    );
    const listingRevision = listingHistory.at(-1)?.streamVersion ?? 0;
    if (
      listing.listingId !== operation.listingId ||
      listing.accountId !== operation.accountId ||
      listing.inventoryItemId !== operation.subject.inventoryItemId ||
      listing.catalogItemId !== operation.subject.catalogItemId ||
      listing.productId !== operation.subject.productId ||
      !isDeepStrictEqual(listing.selectedOptions, operation.subject.selectedOptions) ||
      listingRevision !== operation.expectedListingRevision ||
      (operation.expectedVisibilityRevision !== null &&
        listing.nativeVisibilityRevision !== operation.expectedVisibilityRevision) ||
      (operation.expectedPublicationRevision !== null &&
        listing.nativePublicationRevision !== operation.expectedPublicationRevision)
    ) {
      throw new Error("Native Listing identity or authority revision changed.");
    }
    if (
      commitment &&
      (operation.kind !== "native-commitment" ||
        !operation.subject.commitmentSourceId ||
        operation.expectedTargetRevision !== listing.nativePriceRevision ||
        operation.expectedVisibilityRevision !== listing.nativeVisibilityRevision ||
        operation.expectedPublicationRevision !== listing.nativePublicationRevision ||
        listing.nativePublicationRevision === null ||
        listing.nativeVisibility !== "enabled" ||
        listing.nativeFeeState !== "enrolled" ||
        listing.status !== "active" ||
        listing.priceAmount !== operation.subject.pair.amount ||
        listing.priceCurrencyCode !== operation.subject.pair.currencyCode ||
        operation.subject.quantity < 1 ||
        operation.subject.quantity > listing.quantityCap)
    )
      throw new Error("Native commitment is no longer eligible.");
    const availabilityStream = `marketplace.seller-listing-availability-${operation.accountId}`;
    const availabilityHistory = await readCompleteStream(deps.eventStore, { streamId: availabilityStream });
    const availability = availabilityHistory.reduce(
      (state, event) =>
        evolveSellerListingAvailability(state, {
          type: event.eventType,
          data: event.payload,
        } as SellerListingAvailabilityEvent),
      initialSellerListingAvailabilityState,
    );
    const at = (deps.now?.() ?? new Date()).toISOString();
    if (
      availability.status !== "available" ||
      (availability.pendingAwayWindow && Date.parse(availability.pendingAwayWindow.startsAt) <= Date.parse(at))
    )
      throw new Error("Seller Listing availability is disabled.");
    // Every upstream grant names this final operation. No intermediate Marketplace terminal releases it.
    const session = operation.principal?.kind === "user" && operation.principal.authentication.kind === "session";
    if (session && !ports.session) throw new Error("Native Auth session authority is not mounted.");
    const sessionGrant = session ? await prepareListingSessionAuthority(operation, context, ports.session!) : null;
    const identityGrant = await identity.participant.prepare(operation, context);
    const catalogGrant = await catalog.participant.prepare(operation, context);
    if (identityGrant.status !== "reserved" || catalogGrant.status !== "reserved")
      throw new Error("Native upstream promise is no longer reserved.");
    const product = await catalog.readFacts(operation);
    if (
      product.catalogItemId !== listing.catalogItemId ||
      product.productId !== listing.productId ||
      !isDeepStrictEqual(product.selectedOptions, listing.selectedOptions) ||
      !product.productMeasureSnapshot ||
      product.productMeasureRevision < 1
    )
      throw new Error("Native Product shipping authority is unavailable.");
    const seller = {
      ...identity.sellerFacts(identityGrant),
      reviewCount: await facts.sellerReviewCount(operation.accountId),
    };
    const policy = await facts.evidencePolicy(at);
    const evidenceRequirements = createListingEvidenceRequirementSnapshot(
      evaluateListingEvidencePolicy(
        policy.value,
        {
          catalogItemId: product.catalogItemId,
          productId: product.productId,
          blueprintId: product.blueprintId,
          categoryIds: product.categoryIds,
          selectedOptions: product.selectedOptions,
          gradedItem: listing.gradedCard !== null,
          priceAmount: operation.subject.pair.amount,
          seller: { ...seller, riskLevel: null },
        },
        policy.metadata,
      ),
      at,
    );
    const readiness = evaluateListingEvidenceReadiness({
      snapshot: evidenceRequirements,
      evidence: listing.evidence,
      seller,
      now: at,
    });
    if (!readiness.ready) throw new Error(`Native evidence is not ready: ${readiness.unmetCodes.join(", ")}.`);
    const deadlines = [
      operation.prepareBefore,
      identityGrant.validBefore,
      catalogGrant.validBefore,
      sessionGrant?.validBefore,
      availability.pendingAwayWindow?.startsAt,
      ...policy.boundaries.filter((boundary) => boundary && Date.parse(boundary) > Date.parse(at)),
    ];
    for (const covered of readiness.coverage?.slots ?? []) {
      const slot = evidenceRequirements.requirements.requiredSlots.find((entry) => entry.slotId === covered.slotId)!;
      const photo = listing.evidence.find((entry) => entry.photoId === covered.matchedPhotoId);
      if (photo && slot.maximumAgeHours !== null)
        deadlines.push(
          new Date(Date.parse(photo.capturedAt ?? photo.uploadedAt) + slot.maximumAgeHours * 3_600_000).toISOString(),
        );
    }
    const upstream = [...(sessionGrant ? [sessionGrant] : []), identityGrant, catalogGrant];
    if (commitment) {
      if (
        !ports.inventory ||
        ports.inventory.participant.owner !== "inventory" ||
        ports.inventory.participant.purpose !== "stock-allocation"
      )
        throw new Error("Native purchase hold authority is not mounted.");
      const stock = await ports.inventory.prepare(operation, context);
      if (stock.status !== "reserved") throw new Error("Native purchase hold is no longer reserved.");
      upstream.push(stock);
      deadlines.push(stock.validBefore);
    }
    const validBefore = deadlines
      .filter((value): value is string => typeof value === "string")
      .reduce(
        (earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest),
        operation.prepareBefore,
      );
    if (!Number.isFinite(Date.parse(validBefore)) || Date.parse(validBefore) <= Date.parse(at))
      throw new Error("Native authority expired.");
    const value: ListingNativeReadinessAuthority = {
      listingId: operation.listingId,
      accountId: operation.accountId,
      productMeasureSnapshot: product.productMeasureSnapshot,
      productMeasureRevision: product.productMeasureRevision,
      evidenceRequirements,
      seller,
    };
    return {
      value: {
        readiness: toJsonValue(value),
        upstreamReservationIds: upstream.map((grant) => grant.reservationId),
        eligible: true,
      },
      validBefore,
      sourceRevisions: [
        { resourceId: listingStream, revision: String(listingRevision) },
        { resourceId: availabilityStream, revision: String(availabilityHistory.at(-1)?.streamVersion ?? 0) },
        { resourceId: resource.reviews(operation.accountId), revision: String(seller.reviewCount) },
        ...policy.documents.map((document) => ({ resourceId: document.streamId, revision: String(document.revision) })),
      ],
      localAppends: [
        { streamId: listingStream, expectedVersion: listingRevision, context, events: [] },
        {
          streamId: availabilityStream,
          expectedVersion: availabilityHistory.at(-1)?.streamVersion ?? 0,
          context,
          events: [],
        },
        ...policy.documents.map((document) => ({
          streamId: document.streamId,
          expectedVersion: document.revision,
          context,
          events: [],
        })),
      ],
    };
  }
  const readiness = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    resourceScope: "owner",
    participant: { owner: "marketplace", purpose: "native-readiness" },
    consumer: ports.consumer,
    resources,
    validate: (operation, context) => validate(operation, context, false),
  });
  const commitment = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    resourceScope: "owner",
    participant: { owner: "marketplace", purpose: "native-commitment" },
    consumer: ports.consumer,
    resources,
    validate: (operation, context) => validate(operation, context, true),
  });
  const writer = createListingAuthorityWriter({
    eventStore: deps.eventStore,
    owner: "marketplace",
    source: readiness,
    resources: facts.writerResources,
  });

  return {
    recover: createListingAuthorityRecovery({
      db: deps.db,
      owner: "marketplace",
      sources: [readiness, commitment],
      consumer: ports.consumer,
      resume: writer.resume,
      resumeWrite: writer.resumeWrite,
      now: deps.now,
    }),
    readiness,
    commitment,
    ...writer,
    async readReadiness(
      operation: ListingAuthorityOperation,
      context: EventStoreContext,
    ): Promise<ListingAuthorityResult<ListingNativeReadinessAuthority>> {
      const own = await readiness.prepare(operation, context);
      const identity = await ports.identity!.participant.inspect(operation);
      const catalog = await ports.catalog!.participant.inspect(operation);
      if (!identity || !catalog) throw new Error("Native upstream reservation history is missing.");
      const sessionRequired =
        operation.principal?.kind === "user" && operation.principal.authentication.kind === "session";
      const session = sessionRequired ? await ports.session?.inspect(operation) : null;
      if (sessionRequired && !session) throw new Error("Native Auth session reservation history is missing.");
      return {
        value: own.value.readiness as unknown as ListingNativeReadinessAuthority,
        reservations: [...(session ? [session] : []), identity, catalog, own],
      };
    },
  };
}
