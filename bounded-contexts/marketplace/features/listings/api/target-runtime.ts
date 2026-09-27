import { createId, type EventId } from "@chase-sets/primitives/typed-ids";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { marketplaceListingCodec } from "../domain/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  decideMarketplaceListing,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { listingPriceTargetKey, normalizeAcceptedListingPrice } from "../domain/target-price";
import { requoteMarketplaceListingFeeLock } from "../../../support/runtime-support/fee-quotes";
import { createListingRequestExecutor } from "./listing-request";
import {
  acceptListingTargetPriceSchema,
  activateListingForChannelSchema,
  setNativeListingVisibilitySchema,
  resumeListingSchema,
} from "./target-validation";
import type {
  AcceptListingTargetPriceInput,
  AcceptedListingTargetPriceV1,
  ListingAuthorityGuard,
  ListingMutationInput,
  ListingTargetAuthority,
  ListingTargetServices,
  NativeListingEligibilityV1,
  SetNativeListingVisibilityInput,
} from "./target-contracts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validateMutation(input: ListingMutationInput) {
  assert(input.accountId.trim() && input.listingId.trim(), "Listing identity is required.");
  assert(
    Number.isSafeInteger(input.expectedListingVersion) && input.expectedListingVersion > 0,
    "Listing version is required.",
  );
}

export function createListingTargetRuntime(
  deps: Readonly<{
    eventStore: EventStore;
    authority?: ListingTargetAuthority;
    load(listingId: string): Promise<Readonly<{ state: MarketplaceListingState; version: number }>>;
    prepareNativeEnable(
      state: MarketplaceListingState,
      input: SetNativeListingVisibilityInput,
    ): Promise<MarketplaceListingCommand>;
    capacityAppends(
      state: MarketplaceListingState,
      events: readonly MarketplaceListingEvent[],
      context: EventStoreContext,
    ): Promise<readonly AppendToStreamInput[]>;
  }>,
): ListingTargetServices {
  const execute = createListingRequestExecutor(deps.eventStore);
  const codec = marketplaceListingCodec;

  async function owned(listingId: string, accountId: string) {
    const loaded = await deps.load(listingId);
    assert(loaded.state.listingId === listingId && loaded.state.accountId === accountId, "Listing not found.");
    return loaded;
  }

  async function authorize(input: ListingMutationInput, context: EventStoreContext) {
    validateMutation(input);
    assert(context.audit.forAccountId === input.accountId, "Listing request account authority mismatch.");
    assert(deps.authority, "Listing target authority is unavailable.");
    const authority = await deps.authority.authorizeManage({ accountId: input.accountId }, context);
    assert(authority.value && authority.guards.length > 0, "Current listings.manage capability is required.");
    return authority.guards;
  }

  function guardAppends(guards: readonly ListingAuthorityGuard[], context: EventStoreContext): AppendToStreamInput[] {
    const unique = new Map<string, number>();
    for (const guard of guards) {
      assert(
        guard.streamId && Number.isSafeInteger(guard.expectedVersion) && guard.expectedVersion >= 0,
        "Invalid authority guard.",
      );
      const prior = unique.get(guard.streamId);
      assert(prior === undefined || prior === guard.expectedVersion, "Authority changed while preparing the command.");
      unique.set(guard.streamId, guard.expectedVersion);
    }
    return [...unique].map(([streamId, expectedVersion]) => ({ streamId, expectedVersion, context, events: [] }));
  }

  async function connection(accountId: string, connectionId: string) {
    assert(deps.authority, "Listing target authority is unavailable.");
    const resolved = await deps.authority.resolveConnection({ accountId, connectionId });
    assert(
      resolved.value?.connectionId === connectionId &&
        resolved.value.accountId === accountId &&
        resolved.guards.length > 0,
      "Owned current connection authority is required.",
    );
    assert(resolved.value.identityRevision > 0 && resolved.value.providerKey, "Connection identity is incomplete.");
    return { value: resolved.value, guards: resolved.guards };
  }

  const acceptListingTargetPrice: ListingTargetServices["acceptListingTargetPrice"] = async (input, context) => {
    input = acceptListingTargetPriceSchema.parse(input);
    const capabilityGuards = await authorize(input, context);
    listingPriceTargetKey(input.target);
    const pair = normalizeAcceptedListingPrice(input.priceAmount, input.priceCurrencyCode);
    assert(
      Number.isSafeInteger(input.expectedTargetPriceRevision) && input.expectedTargetPriceRevision >= 0,
      "Target revision is required.",
    );
    // Historical provenance is decode-only, never a client authorization claim.
    assert(input.decision.kind !== "legacy-native-anchor", "Historical price provenance cannot authorize a command.");
    assert(
      input.target.kind === "native-marketplace" || input.decision.kind === "pricing-evaluation",
      "External prices require a verified Pricing decision.",
    );
    return execute({
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      command: { type: "AcceptListingTargetPrice", ...input, ...pair },
      context,
      prepare: async () => {
        const { state, version } = await owned(input.listingId, input.accountId);
        assert(version === input.expectedListingVersion, "Listing revision changed.");
        const guards = [...capabilityGuards];
        if (input.decision.kind === "pricing-evaluation") {
          const verified = await deps.authority!.verifyDecision({ ...input, ...pair }, context);
          assert(verified.value && verified.guards.length > 0, "Current Pricing decision authority is required.");
          assert(input.decision.basePriceRevision === state.nativePriceRevision, "Pricing base reference changed.");
          guards.push(...verified.guards);
        }
        const resolved =
          input.target.kind === "channel-connection"
            ? await connection(input.accountId, input.target.connectionId)
            : null;
        if (resolved) guards.push(...resolved.guards);
        const sourceEventId = createId("evt");
        const accepted: AcceptedListingTargetPriceV1 = {
          schemaVersion: 1,
          accountId: input.accountId,
          listingId: input.listingId,
          target: input.target,
          ...pair,
          targetPriceRevision: version + 1,
          listingRevision: version + 1,
          acceptedByUserId: context.audit.performedByUserId,
          acceptedAt: new Date().toISOString(),
          sourceEventId,
          decision: input.decision,
          connectionAuthority: resolved
            ? {
                connectionId: resolved.value.connectionId,
                providerKey: resolved.value.providerKey,
                environment: resolved.value.environment,
                identityRevision: resolved.value.identityRevision,
              }
            : null,
        };
        const events = decideMarketplaceListing(state, {
          type: "AcceptListingTargetPrice",
          acceptedTargetPrice: accepted,
          expectedTargetPriceRevision: input.expectedTargetPriceRevision,
          feeLocks:
            input.target.kind === "native-marketplace"
              ? state.feeLocks.map((lock) => requoteMarketplaceListingFeeLock(lock, pair.priceAmount))
              : [],
        });
        assert(events.length === 1, "Price acceptance must retain one owner fact.");
        return {
          result: { listingId: input.listingId, version: version + 1, acceptedTargetPrice: accepted },
          appends: [
            ...guardAppends(guards, context),
            {
              streamId: `marketplace.listing-${input.listingId}`,
              expectedVersion: version,
              context,
              events: events.map((event) => ({ ...codec.encode(event), eventId: sourceEventId as EventId })),
            },
          ],
        };
      },
    });
  };

  async function mutate(
    input: ListingMutationInput,
    context: EventStoreContext,
    type: string,
    prepare: (
      state: MarketplaceListingState,
    ) => Promise<
      Readonly<{ command: MarketplaceListingCommand; guards: readonly ListingAuthorityGuard[]; capacity: boolean }>
    >,
  ) {
    const capabilityGuards = await authorize(input, context);
    return execute({
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      command: { ...input, type },
      context,
      prepare: async () => {
        const { state, version } = await owned(input.listingId, input.accountId);
        assert(version === input.expectedListingVersion, "Listing revision changed.");
        const prepared = await prepare(state);
        const events = decideMarketplaceListing(state, prepared.command);
        const capacity = prepared.capacity ? await deps.capacityAppends(state, events, context) : [];
        return {
          result: { listingId: input.listingId, version: version + events.length },
          appends: [
            ...guardAppends([...capabilityGuards, ...prepared.guards], context),
            ...capacity,
            {
              streamId: `marketplace.listing-${input.listingId}`,
              expectedVersion: version,
              context,
              events: events.map(codec.encode),
            },
          ],
        };
      },
    });
  }

  async function source(listingId: string, accountId: string) {
    // Load history once rather than mix an aggregate read with a later event read.
    const events = await readCompleteStream(deps.eventStore, { streamId: `marketplace.listing-${listingId}` });
    const latest = events.at(-1);
    assert(latest, "Listing not found.");
    const loaded = await owned(listingId, accountId);
    assert(loaded.version === latest.streamVersion, "Listing source changed during read.");
    return { ...loaded, events, latest };
  }

  function nativeAccepted(read: Awaited<ReturnType<typeof source>>): AcceptedListingTargetPriceV1 | null {
    const current = read.state.acceptedTargetPrices["native-marketplace"];
    if (current?.targetPriceRevision === read.state.nativePriceRevision) return current;
    const event = read.events.find((entry) => entry.streamVersion === read.state.nativePriceRevision);
    if (!event || !read.state.priceAmount || !read.state.priceCurrencyCode) return null;
    return {
      schemaVersion: 1,
      accountId: read.state.accountId!,
      listingId: read.state.listingId!,
      target: { kind: "native-marketplace" },
      priceAmount: read.state.priceAmount,
      priceCurrencyCode: read.state.priceCurrencyCode,
      targetPriceRevision: event.streamVersion,
      listingRevision: event.streamVersion,
      acceptedByUserId: event.performedByUserId,
      acceptedAt: event.occurredAt,
      sourceEventId: event.eventId,
      decision: { kind: "legacy-native-anchor" },
      connectionAuthority: null,
    };
  }

  return {
    acceptListingTargetPrice,
    acceptListingTargetPrices: async ({ accountId, updates }, context) => {
      assert(updates.length <= 100, "At most 100 target acceptances are allowed.");
      const results = [];
      for (const update of updates) {
        try {
          results.push({
            listingId: update.listingId,
            target: update.target,
            result: await acceptListingTargetPrice({ accountId, ...update }, context),
            error: null,
          });
        } catch (error) {
          results.push({
            listingId: update.listingId,
            target: update.target,
            result: null,
            error: error instanceof Error ? error.message : "Price acceptance failed.",
          });
        }
      }
      return results;
    },
    activateListingForChannel: (raw, context) => {
      const input = activateListingForChannelSchema.parse(raw);
      return mutate(input, context, "ActivateListingForChannel", async (state) => {
        const resolved = await connection(input.accountId, input.connectionId);
        const allocation = await deps.authority!.resolveAllocation({
          accountId: input.accountId,
          inventoryItemId: state.inventoryItemId!,
          productId: state.productId!,
          connectionId: input.connectionId,
          allocationRevision: input.allocationRevision,
        });
        assert(
          allocation.value &&
            allocation.guards.length > 0 &&
            allocation.value.accountId === input.accountId &&
            allocation.value.inventoryItemId === state.inventoryItemId &&
            allocation.value.productId === state.productId &&
            allocation.value.allocationRevision === input.allocationRevision &&
            allocation.value.eligibleQuantity > 0,
          "Current owned Inventory allocation and stock are required.",
        );
        const accepted =
          state.acceptedTargetPrices[
            listingPriceTargetKey({ kind: "channel-connection", connectionId: input.connectionId })
          ];
        assert(
          accepted?.connectionAuthority?.identityRevision === resolved.value.identityRevision,
          "Accepted connection identity changed.",
        );
        return {
          command: { type: "ActivateListingForChannel", ...input },
          guards: [...resolved.guards, ...allocation.guards],
          capacity: true,
        };
      });
    },
    setNativeListingVisibility: (raw, context) => {
      const input = setNativeListingVisibilitySchema.parse(raw);
      return mutate(input, context, "SetNativeListingVisibility", async (state) => ({
        command:
          input.nativeVisibility === "enabled"
            ? await deps.prepareNativeEnable(state, input)
            : {
                type: "SetNativeListingVisibility",
                nativeVisibility: "disabled",
                feeLocks: state.feeLocks,
                evidenceRequirements: state.evidenceRequirements,
                readiness: null,
              },
        guards: [],
        capacity: input.nativeVisibility === "enabled",
      }));
    },
    resumeListing: (raw, context) => {
      const input = resumeListingSchema.parse(raw);
      return mutate(input, context, "ResumeListing", async () => {
        const authorization = await deps.authority!.authorizeResume(input, context);
        assert(authorization.value && authorization.guards.length > 0, "Current pause-owner authority is required.");
        return {
          command: { type: "ResumeListing", expectedPauseReason: input.expectedPauseReason },
          guards: authorization.guards,
          capacity: true,
        };
      });
    },
    readAcceptedListingTargetPrices: async ({ accountId, targets }) => {
      assert(targets.length <= 100, "At most 100 target reads are allowed.");
      const reads = new Map<string, Awaited<ReturnType<typeof source>>>();
      const results = [];
      for (const target of targets) {
        const read = reads.get(target.listingId) ?? (await source(target.listingId, accountId));
        reads.set(target.listingId, read);
        const key = listingPriceTargetKey(target.target);
        results.push({
          ...target,
          acceptedTargetPrice:
            target.target.kind === "native-marketplace"
              ? nativeAccepted(read)
              : (read.state.acceptedTargetPrices[key] ?? null),
          activationRevision:
            target.target.kind === "channel-connection"
              ? (read.state.channelActivations[target.target.connectionId]?.revision ?? null)
              : read.state.nativePublicationRevision,
          listingRevision: read.version,
          status: read.state.status,
          generatedAt: new Date().toISOString(),
          sourceEventId: read.latest.eventId,
          sourceGlobalPosition: read.latest.globalPosition,
        });
      }
      return results;
    },
    readNativeListingEligibility: async ({ accountId, listingIds }) => {
      assert(listingIds.length <= 100, "At most 100 native eligibility reads are allowed.");
      const results: NativeListingEligibilityV1[] = [];
      for (const listingId of listingIds) {
        const read = await source(listingId, accountId);
        const state = read.state;
        const blockingReason =
          state.nativeVisibility !== "enabled"
            ? "native-disabled"
            : state.nativePublicationRevision === null
              ? "native-unpublished"
              : state.status !== "active"
                ? "listing-not-active"
                : !state.priceAmount || !state.priceCurrencyCode
                  ? "price-incomplete"
                  : null;
        results.push({
          schemaVersion: 1,
          accountId,
          listingId,
          priceAmount: state.priceAmount,
          priceCurrencyCode: state.priceCurrencyCode,
          targetPriceRevision: state.nativePriceRevision,
          listingRevision: read.version,
          visibilityRevision: state.nativeVisibilityRevision,
          nativePublicationRevision: state.nativePublicationRevision,
          eligible: blockingReason === null,
          blockingReason,
          sourceEventId: read.latest.eventId,
          generatedAt: new Date().toISOString(),
        });
      }
      return results;
    },
  };
}
