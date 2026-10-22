import { createId, type EventId } from "@chase-sets/primitives/typed-ids";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  assertOwnerStreamReservationShape,
  toOwnerStreamCommitParticipant,
  type OwnerStreamCommitParticipant,
  type OwnerStreamReservation,
} from "@chase-sets/event-core/owner-seal";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { decideMarketplaceListing, type MarketplaceListingEvent, type MarketplaceListingState } from "../domain/domain";
import {
  listingPriceTargetKey,
  normalizeAcceptedListingPrice,
  type AcceptedListingTargetPriceV1,
} from "../domain/target-price";
import { acceptListingTargetPriceSchema, activateListingForChannelSchema } from "./target-validation";
import type {
  AcceptListingTargetPriceInput,
  ActivateListingForChannelInput,
  ListingTargetAuthority,
  ListingTargetPriceAcceptanceResult,
  ListingTargetServices,
} from "./target-contracts";
import { createListingRequestExecutor } from "./listing-request";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function createListingTargetRuntime(
  deps: Readonly<{
    eventStore: EventStore;
    authority?: ListingTargetAuthority;
    load(listingId: string): Promise<Readonly<{ state: MarketplaceListingState; version: number }>>;
  }>,
): ListingTargetServices {
  const execute = createListingRequestExecutor(deps.eventStore);
  const codec = createPassthroughDomainEventCodec<MarketplaceListingEvent>();

  async function owned(input: Readonly<{ listingId: string; accountId: string }>) {
    const loaded = await deps.load(input.listingId);
    assert(
      loaded.state.listingId === input.listingId && loaded.state.accountId === input.accountId,
      "Listing not found.",
    );
    return loaded;
  }
  async function manage(input: Readonly<{ accountId: string }>, context: EventStoreContext) {
    assert(context.audit.forAccountId === input.accountId, "Listing request account authority mismatch.");
    assert(deps.authority, "Listing target authority is unavailable.");
    const result = await deps.authority.authorizeManage(input, context);
    assert(result.value, "Current listings.manage capability is required.");
    return result.reservations;
  }

  async function revalidate(reservations: readonly OwnerStreamReservation[]) {
    for (const reservation of reservations) {
      assertOwnerStreamReservationShape(reservation);
      await reservation.assertCurrent();
    }
  }
  function commitParticipants(
    reservations: readonly OwnerStreamReservation[],
  ): readonly OwnerStreamCommitParticipant[] {
    return reservations.map((reservation) => toOwnerStreamCommitParticipant(reservation));
  }
  const acceptListingTargetPrice: ListingTargetServices["acceptListingTargetPrice"] = async (raw, context) => {
    const input = acceptListingTargetPriceSchema.parse(raw) as AcceptListingTargetPriceInput;
    const pair = normalizeAcceptedListingPrice(input.priceAmount, input.priceCurrencyCode);
    return execute({
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      command: { ...input, ...pair },
      context,
      prepare: async () => {
        const reservations = await manage(input, context);
        assert(
          input.decision.kind !== "pricing-evaluation" || deps.authority?.verifyDecision,
          "Pricing decision authority is unavailable.",
        );
        const loaded = await owned(input);
        assert(loaded.version === input.expectedListingVersion, "Listing revision changed.");
        const grants = [...reservations];
        if (input.decision.kind === "pricing-evaluation") {
          const verified = await deps.authority!.verifyDecision!(input, context);
          assert(verified.value, "Current Pricing decision authority is required.");
          grants.push(...verified.reservations);
        }
        const resolved =
          input.target.kind === "channel-connection"
            ? await deps.authority!.resolveConnection(
                {
                  accountId: input.accountId,
                  connectionId: input.target.connectionId,
                },
                context,
              )
            : null;
        if (input.target.kind === "channel-connection") {
          assert(resolved?.value, "Owned current connection authority is required.");
          assert(
            resolved.value.accountId === input.accountId && resolved.value.connectionId === input.target.connectionId,
            "Connection authority identity mismatch.",
          );
          grants.push(...resolved.reservations);
        }
        const accepted: AcceptedListingTargetPriceV1 = {
          schemaVersion: 1,
          accountId: input.accountId,
          listingId: input.listingId,
          target: input.target,
          ...pair,
          targetPriceRevision:
            (loaded.state.acceptedTargetPrices[listingPriceTargetKey(input.target)]?.targetPriceRevision ??
              loaded.state.nativePriceRevision) + 1,
          listingRevision: loaded.version + 1,
          acceptedByUserId: String(context.audit.performedByUserId),
          acceptedAt: new Date().toISOString(),
          sourceEventId: createId("evt"),
          decision: input.decision,
          connectionAuthority: resolved?.value ?? null,
        };
        const events = decideMarketplaceListing(loaded.state, {
          type: "AcceptListingTargetPrice",
          acceptedTargetPrice: accepted,
          expectedTargetPriceRevision: input.expectedTargetPriceRevision,
        });
        await revalidate(grants);
        return {
          result: {
            listingId: input.listingId,
            version: loaded.version + events.length,
            acceptedTargetPrice: accepted,
          },
          appends: [
            {
              streamId: `marketplace.listing-${input.listingId}`,
              expectedVersion: loaded.version,
              context,
              events: events.map((event) => ({ ...codec.encode(event), eventId: accepted.sourceEventId as EventId })),
            },
          ],
          commitParticipants: commitParticipants(grants),
        };
      },
    });
  };
  const activateListingForChannel: ListingTargetServices["activateListingForChannel"] = async (raw, context) => {
    const input = activateListingForChannelSchema.parse(raw) as ActivateListingForChannelInput;
    return execute({
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      command: input,
      context,
      prepare: async () => {
        const reservations = await manage(input, context);
        const loaded = await owned(input);
        assert(loaded.version === input.expectedListingVersion, "Listing revision changed.");
        const connection = await deps.authority?.resolveConnection(
          {
            accountId: input.accountId,
            connectionId: input.connectionId,
          },
          context,
        );
        assert(connection?.value, "Current channel connection authority is required.");
        assert(
          connection.value.accountId === input.accountId && connection.value.connectionId === input.connectionId,
          "Channel connection authority identity mismatch.",
        );
        const allocation = await deps.authority!.resolveAllocation(
          {
            accountId: input.accountId,
            inventoryItemId: loaded.state.inventoryItemId!,
            productId: loaded.state.productId!,
            connectionId: input.connectionId,
            allocationRevision: input.allocationRevision,
          },
          context,
        );
        assert(allocation.value, "Current Inventory allocation is required.");
        assert(
          allocation.value.accountId === input.accountId &&
            allocation.value.inventoryItemId === loaded.state.inventoryItemId &&
            allocation.value.productId === loaded.state.productId &&
            allocation.value.allocationRevision === input.allocationRevision &&
            allocation.value.eligibleQuantity > 0,
          "Inventory allocation authority identity mismatch.",
        );
        const grants = [...reservations, ...connection.reservations, ...allocation.reservations];
        const events = decideMarketplaceListing(loaded.state, {
          type: "ActivateListingForChannel",
          connectionId: input.connectionId,
          expectedTargetPriceRevision: input.expectedTargetPriceRevision,
          allocationRevision: input.allocationRevision,
        });
        await revalidate(grants);
        return {
          result: { listingId: input.listingId, version: loaded.version + events.length },
          appends: [
            {
              streamId: `marketplace.listing-${input.listingId}`,
              expectedVersion: loaded.version,
              context,
              events: events.map(codec.encode),
            },
          ],
          commitParticipants: commitParticipants(grants),
        };
      },
    });
  };
  return {
    acceptListingTargetPrice,
    activateListingForChannel,
    readAcceptedListingTargetPrices: async ({ accountId, targets }) =>
      Promise.all(
        targets.map(async ({ listingId, target }) => {
          const loaded = await owned({ listingId, accountId });
          const acceptedTargetPrice = loaded.state.acceptedTargetPrices[listingPriceTargetKey(target)] ?? null;
          return {
            listingId,
            target,
            acceptedTargetPrice,
            activationRevision:
              target.kind === "channel-connection"
                ? (loaded.state.channelActivations[target.connectionId]?.revision ?? null)
                : null,
            listingRevision: loaded.version,
          };
        }),
      ),
  };
}
