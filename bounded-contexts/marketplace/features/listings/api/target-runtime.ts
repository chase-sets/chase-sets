import { createId, type EventId } from "@chase-sets/primitives/typed-ids";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { createBulkAppendLane } from "@chase-sets/platform-runtime/bulk-append-lane";
import { marketplaceListingCodec } from "../domain/codec";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  decideMarketplaceListing,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { listingPriceTargetKey, normalizeAcceptedListingPrice } from "../domain/target-price";
import { requoteMarketplaceListingFeeLock } from "../../../support/runtime-support/fee-quotes";
import type { MarketplaceBulkListingPriceUpdateInput, MarketplaceBulkListingPriceUpdateOutcome } from "../ui/contracts";
import { createListingRequestExecutor, prepareListingRequest, type ListingRequestInput } from "./listing-request";
import {
  acceptListingTargetPriceSchema,
  activateListingForChannelSchema,
  setNativeListingVisibilitySchema,
  resumeListingSchema,
  nativeListingPriceUpdateSchema,
} from "./target-validation";
import type {
  AcceptListingTargetPriceInput,
  AcceptedListingTargetPriceV1,
  ListingAuthorityGuard,
  ListingMutationInput,
  ListingTargetAuthority,
  ListingTargetServices,
  ListingTargetPriceAcceptanceResult,
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
    bulkPolicy?(): Promise<Readonly<{ chunkSize: number; yieldIntervalMs: number }>>;
    nativePriceConfirmation?(accountId: string): Promise<(priceAmount: string, fingerprint: string) => void>;
    confirmNativePrice?(accountId: string, priceAmount: string, fingerprint: string): Promise<void>;
    load(listingId: string): Promise<Readonly<{ state: MarketplaceListingState; version: number }>>;
    prepareNativeEnable(
      state: MarketplaceListingState,
      input: SetNativeListingVisibilityInput,
    ): Promise<Readonly<{ command: MarketplaceListingCommand; guards: readonly ListingAuthorityGuard[] }>>;
    capacityAppends(
      state: MarketplaceListingState,
      events: readonly MarketplaceListingEvent[],
      context: EventStoreContext,
    ): Promise<readonly AppendToStreamInput[]>;
  }>,
) {
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

  async function acceptanceRequest(
    input: AcceptListingTargetPriceInput,
    context: EventStoreContext,
  ): Promise<ListingRequestInput<ListingTargetPriceAcceptanceResult>> {
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
      !input.changeSource || input.decision.kind === "pricing-evaluation",
      "Pricing provenance requires verified decision authority.",
    );
    assert(
      input.target.kind === "native-marketplace" || input.decision.kind === "pricing-evaluation",
      "External prices require a verified Pricing decision.",
    );
    return {
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
          changeSource: input.changeSource,
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
    };
  }

  const acceptListingTargetPrice: ListingTargetServices["acceptListingTargetPrice"] = async (input, context) =>
    execute(await acceptanceRequest(input, context));

  async function nativeRequest(
    accountId: string,
    update: MarketplaceBulkListingPriceUpdateInput,
    context: EventStoreContext,
    confirm: (priceAmount: string, fingerprint: string) => Promise<void>,
  ): Promise<ListingRequestInput<{ listingId: string; version: number; outcome: "applied" | "no_op" }>> {
    update = nativeListingPriceUpdateSchema.parse(update);
    const pair = normalizeAcceptedListingPrice(update.priceAmount, update.priceCurrencyCode);
    const guards = await authorize(
      {
        accountId,
        listingId: update.listingId,
        expectedListingVersion: update.expectedVersion ?? 1,
        idempotencyKey: update.idempotencyKey ?? "native-adapter",
      },
      context,
    );
    return {
      accountId,
      idempotencyKey: update.idempotencyKey ?? createId("evt"),
      command: { type: "AcceptNativeListingPrice", accountId, ...update, ...pair },
      context,
      prepare: async () => {
        const { state, version } = await owned(update.listingId, accountId);
        if (update.expectedVersion !== undefined && update.expectedVersion !== version) {
          throw createEventStoreError(
            "concurrency_conflict",
            "Expected stream version does not match current version.",
            { currentVersion: version },
          );
        }
        if (
          update.expectedTargetPriceRevision !== undefined &&
          update.expectedTargetPriceRevision !== state.nativePriceRevision
        ) {
          throw createEventStoreError("concurrency_conflict", "Native target price revision changed.", {
            currentVersion: version,
          });
        }
        if (state.nativeVisibility === "enabled" && update.feeQuoteFingerprint)
          await confirm(pair.priceAmount, update.feeQuoteFingerprint);
        const input = {
          accountId,
          listingId: update.listingId,
          ...pair,
          expectedListingVersion: version,
          expectedTargetPriceRevision: state.nativePriceRevision,
          idempotencyKey: update.idempotencyKey ?? "native-adapter",
          target: { kind: "native-marketplace" } as const,
          decision: update.decision ?? ({ kind: "seller-reference" } as const),
          ...(update.changeSource ? { changeSource: update.changeSource } : {}),
        };
        const request = await acceptanceRequest(input, context);
        const prepared = await request.prepare();
        // Legacy native callers preserve suppression, but a new Pricing decision is always a new authority fact.
        if (
          !update.decision &&
          !update.changeSource &&
          decideMarketplaceListing(state, {
            type: "UpdateListingPrice",
            ...pair,
            feeLocks: state.feeLocks.map((lock) => requoteMarketplaceListingFeeLock(lock, pair.priceAmount)),
            minimumChange: update.minimumChange,
          }).length === 0
        ) {
          return {
            result: { listingId: update.listingId, version, outcome: "no_op" },
            appends: [
              ...guardAppends(guards, context),
              { streamId: `marketplace.listing-${update.listingId}`, expectedVersion: version, events: [], context },
            ],
          };
        }
        return {
          result: { listingId: update.listingId, version: prepared.result.version, outcome: "applied" },
          appends: prepared.appends,
        };
      },
    };
  }

  async function applyNativePrices(
    input: Readonly<{ accountId: string; updates: readonly MarketplaceBulkListingPriceUpdateInput[] }>,
    context: EventStoreContext,
  ): Promise<readonly MarketplaceBulkListingPriceUpdateOutcome[]> {
    let confirmation: ReturnType<NonNullable<typeof deps.nativePriceConfirmation>> | undefined;
    const confirm = async (amount: string, fingerprint: string) => {
      assert(deps.nativePriceConfirmation, "Native fee confirmation is unavailable.");
      confirmation ??= deps.nativePriceConfirmation(input.accountId);
      (await confirmation)(amount, fingerprint);
    };
    const policy = (await deps.bulkPolicy?.()) ?? { chunkSize: 100, yieldIntervalMs: 0 };
    const lane = createBulkAppendLane({
      eventStore: deps.eventStore,
      ...policy,
      prepare: async (update: MarketplaceBulkListingPriceUpdateInput) =>
        prepareListingRequest(deps.eventStore, await nativeRequest(input.accountId, update, context, confirm)),
    });
    const outcomes = await lane(input.updates);
    recordCommittedEvents(outcomes.flatMap((outcome) => outcome.storedEvents));
    return outcomes.map(
      ({ result, error }, index) =>
        result ?? {
          listingId: input.updates[index]!.listingId,
          outcome: (error as { code?: string })?.code === "concurrency_conflict" ? "conflict" : "error",
          version: Number((error as { details?: { currentVersion?: number } })?.details?.currentVersion ?? 0),
          message: error?.message ?? "Native acceptance failed.",
        },
    );
  }

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
      decision: {
        kind:
          event.eventType === "marketplace.listing.created" && event.payload.schemaVersion === 2
            ? "seller-reference"
            : "legacy-native-anchor",
      },
      connectionAuthority: null,
    };
  }

  const services: ListingTargetServices = {
    acceptListingTargetPrice,
    acceptListingTargetPrices: async ({ accountId, updates }, context) => {
      assert(updates.length <= 100, "At most 100 target acceptances are allowed.");
      const policy = (await deps.bulkPolicy?.()) ?? { chunkSize: 100, yieldIntervalMs: 0 };
      const lane = createBulkAppendLane({
        eventStore: deps.eventStore,
        ...policy,
        prepare: async (update: Omit<AcceptListingTargetPriceInput, "accountId">) =>
          prepareListingRequest(deps.eventStore, await acceptanceRequest({ ...update, accountId }, context)),
      });
      const outcomes = await lane(updates);
      recordCommittedEvents(outcomes.flatMap((outcome) => outcome.storedEvents));
      return outcomes.map((outcome, index) => ({
        listingId: updates[index]!.listingId,
        target: updates[index]!.target,
        result: outcome.result,
        error: outcome.error?.message ?? null,
      }));
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
      return mutate(input, context, "SetNativeListingVisibility", async (state) => {
        if (input.nativeVisibility === "enabled") {
          return { ...(await deps.prepareNativeEnable(state, input)), capacity: true };
        }
        return {
          command: {
            type: "SetNativeListingVisibility",
            nativeVisibility: "disabled",
            feeLocks: state.feeLocks,
            evidenceRequirements: state.evidenceRequirements,
            readiness: null,
          },
          guards: [],
          capacity: false,
        };
      });
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
  return {
    ...services,
    applyNativePrices,
    updateNativePrice: async (
      input: MarketplaceBulkListingPriceUpdateInput & Readonly<{ accountId: string }>,
      context: EventStoreContext,
    ) => {
      const { accountId, ...update } = input;
      const result = await execute(
        await nativeRequest(accountId, update, context, async (amount, fingerprint) => {
          assert(deps.confirmNativePrice, "Native fee confirmation is unavailable.");
          await deps.confirmNativePrice(accountId, amount, fingerprint);
        }),
      );
      return { listingId: result.listingId, version: result.version };
    },
  };
}
