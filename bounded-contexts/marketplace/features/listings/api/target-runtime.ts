import { createId, type EventId } from "@chase-sets/primitives/typed-ids";
import { moneyToCents, roundRational } from "@chase-sets/primitives/money";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { createBulkAppendLane } from "@chase-sets/platform-runtime/bulk-append-lane";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { requireListingAuthorityPrincipal } from "@chase-sets/event-core/listing-authority";
import type {
  ListingAuthorityOperation,
  ListingAuthorityParticipant,
  ListingAuthorityReservation,
  ListingAuthoritySubject,
} from "@chase-sets/event-core/listing-authority";
import { marketplaceListingCodec } from "../domain/codec";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  decideMarketplaceListing,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { listingPriceTargetKey, normalizeAcceptedListingPrice } from "../domain/target-price";
import { requoteMarketplaceListingFeeLock } from "../../../support/runtime-support/fee-quotes";
import type { MarketplaceBulkListingPriceUpdateInput, MarketplaceBulkListingPriceUpdateOutcome } from "../ui/contracts";
import {
  createListingRequestExecutor,
  prepareListingRequest,
  readListingRequestOperation,
  type ListingRequestInput,
} from "./listing-request";
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
  ListingMutationInput,
  ListingTargetAuthority,
  ListingTargetServices,
  ListingTargetPriceAcceptanceResult,
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

function authoritySubject(state: MarketplaceListingState): ListingAuthoritySubject {
  assert(
    state.inventoryItemId && state.catalogItemId && state.productId,
    "Listing authority product identity is incomplete.",
  );
  return {
    inventoryItemId: state.inventoryItemId,
    catalogItemId: state.catalogItemId,
    productId: state.productId,
    selectedOptions: state.selectedOptions,
    quantity: state.quantityCap,
    pair:
      state.priceAmount && state.priceCurrencyCode
        ? { amount: state.priceAmount, currencyCode: state.priceCurrencyCode }
        : null,
    allocationRevision: null,
    commitmentSourceId: null,
  };
}

function suppressSellerPriceRequest(
  state: MarketplaceListingState,
  pair: Readonly<{ priceAmount: string; priceCurrencyCode: string }>,
  minimumChange: MarketplaceBulkListingPriceUpdateInput["minimumChange"],
) {
  if (state.priceAmount === null || state.priceCurrencyCode !== pair.priceCurrencyCode) return false;
  const current = moneyToCents(state.priceAmount);
  const next = moneyToCents(pair.priceAmount);
  const delta = current > next ? current - next : next - current;
  if (minimumChange) {
    const threshold =
      minimumChange.mode === "absolute"
        ? moneyToCents(minimumChange.amount)
        : roundRational(current * BigInt(Math.round(minimumChange.percent * 100)), 10_000n, "nearest");
    if (delta <= threshold) return true;
  }
  return (
    delta === 0n &&
    state.feeLocks.every((lock) => {
      const quote = requoteMarketplaceListingFeeLock(lock, pair.priceAmount);
      return (
        moneyToCents(quote.marketplaceSalesFeeUnitAmount) === moneyToCents(lock.marketplaceSalesFeeUnitAmount) &&
        moneyToCents(quote.sellerNetUnitAmount) === moneyToCents(lock.sellerNetUnitAmount)
      );
    })
  );
}

export function createListingTargetRuntime(
  deps: Readonly<{
    eventStore: EventStore;
    currentReads?: Pick<ListingTargetServices, "readAcceptedListingTargetPrices" | "readNativeListingEligibility">;
    authority?: ListingTargetAuthority;
    bulkPolicy?(): Promise<Readonly<{ chunkSize: number; yieldIntervalMs: number }>>;
    nativePriceConfirmation?(accountId: string): Promise<(priceAmount: string, fingerprint: string) => void>;
    confirmNativePrice?(accountId: string, priceAmount: string, fingerprint: string): Promise<void>;
    load(listingId: string): Promise<Readonly<{ state: MarketplaceListingState; version: number }>>;
    prepareNativeEnable(
      state: MarketplaceListingState,
      input: SetNativeListingVisibilityInput,
      operation: ListingAuthorityOperation,
    ): Promise<
      Readonly<{
        command: MarketplaceListingCommand;
        reservations: readonly ListingAuthorityReservation[];
        localGuards?: readonly AppendToStreamInput[];
      }>
    >;
    capacityAppends(
      state: MarketplaceListingState,
      events: readonly MarketplaceListingEvent[],
      context: EventStoreContext,
      operation: ListingAuthorityOperation,
    ): Promise<
      Readonly<{ appends: readonly AppendToStreamInput[]; reservations: readonly ListingAuthorityReservation[] }>
    >;
  }>,
) {
  const execute = createListingRequestExecutor(deps.eventStore);
  const fence = createListingAuthorityFence({
    eventStore: deps.eventStore,
    owner: "marketplace",
    participants: deps.authority?.participants ?? [],
  });
  const codec = marketplaceListingCodec;

  async function owned(listingId: string, accountId: string) {
    const loaded = await deps.load(listingId);
    assert(loaded.state.listingId === listingId && loaded.state.accountId === accountId, "Listing not found.");
    return loaded;
  }

  async function authorize(
    input: ListingMutationInput,
    context: EventStoreContext,
    operation: ListingAuthorityOperation,
  ) {
    validateMutation(input);
    assert(context.audit.forAccountId === input.accountId, "Listing request account authority mismatch.");
    assert(deps.authority, "Listing target authority is unavailable.");
    const authority = await deps.authority.authorizeManage({ accountId: input.accountId }, context, operation);
    assert(authority.value && authority.reservations.length > 0, "Current listings.manage capability is required.");
    return authority.reservations;
  }

  async function connection(accountId: string, connectionId: string, operation: ListingAuthorityOperation) {
    assert(deps.authority, "Listing target authority is unavailable.");
    const resolved = await deps.authority.resolveConnection({ accountId, connectionId }, operation);
    assert(
      resolved.value?.connectionId === connectionId &&
        resolved.value.accountId === accountId &&
        resolved.reservations.length > 0,
      "Owned current connection authority is required.",
    );
    assert(resolved.value.identityRevision > 0 && resolved.value.providerKey, "Connection identity is incomplete.");
    return { value: resolved.value, reservations: resolved.reservations };
  }

  async function acceptanceRequest(
    input: AcceptListingTargetPriceInput,
    context: EventStoreContext,
    existingOperation?: ListingAuthorityOperation,
    requestCommand?: import("@chase-sets/primitives/json").JsonObject,
  ): Promise<ListingRequestInput<ListingTargetPriceAcceptanceResult>> {
    input = acceptListingTargetPriceSchema.parse(input);
    validateMutation(input);
    assert(context.audit.forAccountId === input.accountId, "Listing request account authority mismatch.");
    assert(deps.authority, "Listing target authority is unavailable.");
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
    const command = requestCommand ?? { type: "AcceptListingTargetPrice", ...input, ...pair };
    const subject = authoritySubject((await owned(input.listingId, input.accountId)).state);
    const operation =
      existingOperation ??
      (await readListingRequestOperation(deps.eventStore, { ...input, command, context })) ??
      (await fence.open(
        {
          tenantId: context.tenantId,
          accountId: input.accountId,
          actor: await deps.authority!.resolveActor({ principal: requireListingAuthorityPrincipal(context), context }),
          committingOwner: "marketplace",
          kind: "accept-price",
          requestId: input.idempotencyKey,
          command,
          listingId: input.listingId,
          subject: { ...subject, pair: { amount: pair.priceAmount, currencyCode: pair.priceCurrencyCode } },
          target: input.target,
          expectedListingRevision: input.expectedListingVersion,
          expectedTargetRevision: input.expectedTargetPriceRevision,
          expectedVisibilityRevision: null,
          expectedPublicationRevision: null,
          participants: [
            { owner: "identity", purpose: "manage-listing" },
            ...(input.decision.kind === "pricing-evaluation"
              ? [{ owner: "pricing", purpose: "evaluated-price" } as const]
              : []),
            ...(input.target.kind === "channel-connection"
              ? [{ owner: "channels", purpose: "connection" } as const]
              : []),
          ],
        },
        context,
      ));
    return {
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      command,
      context,
      authority: { fence, operation },
      prepare: async () => {
        const { state, version } = await owned(input.listingId, input.accountId);
        assert(version === input.expectedListingVersion, "Listing revision changed.");
        const reservations = [...(await authorize(input, context, operation))];
        if (input.decision.kind === "pricing-evaluation") {
          const verified = await deps.authority!.verifyDecision({ ...input, ...pair }, context, operation);
          assert(verified.value && verified.reservations.length > 0, "Current Pricing decision authority is required.");
          assert(input.decision.basePriceRevision === state.nativePriceRevision, "Pricing base reference changed.");
          reservations.push(...verified.reservations);
        }
        const resolved =
          input.target.kind === "channel-connection"
            ? await connection(input.accountId, input.target.connectionId, operation)
            : null;
        if (resolved) reservations.push(...resolved.reservations);
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
          reservations,
          appends: [
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
    const initial = await owned(update.listingId, accountId);
    const normalized = {
      accountId,
      listingId: update.listingId,
      ...pair,
      expectedListingVersion: update.expectedVersion ?? initial.version,
      expectedTargetPriceRevision: update.expectedTargetPriceRevision ?? initial.state.nativePriceRevision,
      idempotencyKey: update.idempotencyKey ?? createId("evt"),
      target: { kind: "native-marketplace" } as const,
      decision: update.decision ?? ({ kind: "seller-reference" } as const),
      ...(update.changeSource ? { changeSource: update.changeSource } : {}),
    };
    const command = { type: "AcceptNativeListingPrice", accountId, ...update, ...pair };
    const acceptedRequest = await acceptanceRequest(normalized, context, undefined, command);
    return {
      accountId,
      idempotencyKey: normalized.idempotencyKey,
      command,
      context,
      authority: acceptedRequest.authority,
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
        const prepared = await acceptedRequest.prepare();
        // Seller request policy never suppresses a verified Pricing authority fact.
        if (!update.decision && !update.changeSource && suppressSellerPriceRequest(state, pair, update.minimumChange)) {
          return {
            result: { listingId: update.listingId, version, outcome: "no_op" },
            reservations: prepared.reservations,
            appends: [
              { streamId: `marketplace.listing-${update.listingId}`, expectedVersion: version, events: [], context },
            ],
          };
        }
        return {
          result: { listingId: update.listingId, version: prepared.result.version, outcome: "applied" },
          reservations: prepared.reservations,
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
      telemetry: { holderKind: "bulk_listing_price_update", sourceContextName: "marketplace" },
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
      operation: ListingAuthorityOperation,
    ) => Promise<
      Readonly<{
        command: MarketplaceListingCommand;
        reservations: readonly ListingAuthorityReservation[];
        localGuards?: readonly AppendToStreamInput[];
        capacity: boolean;
      }>
    >,
    requestCommand?: JsonObject,
  ) {
    const initial = await owned(input.listingId, input.accountId);
    const nativeEnable =
      type === "SetNativeListingVisibility" &&
      (input as SetNativeListingVisibilityInput).nativeVisibility === "enabled";
    const participants: ListingAuthorityParticipant[] = [{ owner: "identity", purpose: "manage-listing" }];
    if (type === "ActivateListingForChannel") participants.push({ owner: "channels", purpose: "connection" });
    if (nativeEnable || type !== "SetNativeListingVisibility")
      participants.push({ owner: "inventory", purpose: "stock-allocation" });
    if (nativeEnable) {
      participants.push(
        { owner: "catalog", purpose: "product-measures" },
        { owner: "marketplace", purpose: "native-readiness" },
      );
      if (initial.state.feeLocks.reduce((sum, lock) => sum + lock.unitCount, 0) < initial.state.quantityCap) {
        participants.push({ owner: "commercial-terms", purpose: "native-fee" });
      }
    }
    if (
      type === "UpdateListingQuantityCap" &&
      initial.state.nativeVisibility === "enabled" &&
      (input as ListingMutationInput & { quantityCap: number }).quantityCap > initial.state.quantityCap
    )
      participants.push({ owner: "commercial-terms", purpose: "native-fee" });
    const command = requestCommand ?? { ...input, type };
    const operation =
      (await readListingRequestOperation(deps.eventStore, { ...input, command, context })) ??
      (await fence.open(
        {
          tenantId: context.tenantId,
          accountId: input.accountId,
          actor: await deps.authority!.resolveActor({ principal: requireListingAuthorityPrincipal(context), context }),
          committingOwner: "marketplace",
          kind:
            type === "ActivateListingForChannel"
              ? "activate-channel"
              : type === "ResumeListing"
                ? "resume"
                : type === "UpdateListingQuantityCap"
                  ? "capacity"
                  : "native-visibility",
          requestId: input.idempotencyKey,
          command,
          listingId: input.listingId,
          target:
            type === "ActivateListingForChannel"
              ? {
                  kind: "channel-connection",
                  connectionId: (input as import("./target-contracts").ActivateListingForChannelInput).connectionId,
                }
              : { kind: "native-marketplace" },
          expectedListingRevision: input.expectedListingVersion,
          subject: {
            ...authoritySubject(initial.state),
            ...(type === "UpdateListingQuantityCap"
              ? { quantity: (input as ListingMutationInput & { quantityCap: number }).quantityCap }
              : {}),
            allocationRevision:
              type === "ActivateListingForChannel"
                ? (input as import("./target-contracts").ActivateListingForChannelInput).allocationRevision
                : null,
          },
          expectedTargetRevision: null,
          expectedVisibilityRevision: initial.state.nativeVisibilityRevision,
          expectedPublicationRevision: initial.state.nativePublicationRevision,
          participants,
        },
        context,
      ));
    return execute({
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      command,
      context,
      authority: { fence, operation },
      prepare: async () => {
        const { state, version } = await owned(input.listingId, input.accountId);
        assert(version === input.expectedListingVersion, "Listing revision changed.");
        const capabilityReservations = await authorize(input, context, operation);
        const prepared = await prepare(state, operation);
        const events = decideMarketplaceListing(state, prepared.command);
        const capacity = prepared.capacity
          ? await deps.capacityAppends(state, events, context, operation)
          : { appends: [], reservations: [] };
        return {
          result: { listingId: input.listingId, version: version + events.length },
          reservations: [
            ...new Map(
              [...capabilityReservations, ...prepared.reservations, ...capacity.reservations].map((reservation) => [
                reservation.reservationId,
                reservation,
              ]),
            ).values(),
          ],
          appends: [
            ...(prepared.localGuards ?? []),
            ...capacity.appends,
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
      return mutate(input, context, "ActivateListingForChannel", async (state, operation) => {
        const resolved = await connection(input.accountId, input.connectionId, operation);
        const allocation = await deps.authority!.resolveAllocation(
          {
            accountId: input.accountId,
            inventoryItemId: state.inventoryItemId!,
            productId: state.productId!,
            connectionId: input.connectionId,
            allocationRevision: input.allocationRevision,
          },
          operation,
        );
        assert(
          allocation.value &&
            allocation.reservations.length > 0 &&
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
          reservations: [...resolved.reservations, ...allocation.reservations],
          capacity: true,
        };
      });
    },
    setNativeListingVisibility: (raw, context) => {
      const input = setNativeListingVisibilitySchema.parse(raw);
      return mutate(input, context, "SetNativeListingVisibility", async (state, operation) => {
        if (input.nativeVisibility === "enabled") {
          return { ...(await deps.prepareNativeEnable(state, input, operation)), capacity: true };
        }
        return {
          command: {
            type: "SetNativeListingVisibility",
            nativeVisibility: "disabled",
            feeLocks: state.feeLocks,
            evidenceRequirements: state.evidenceRequirements,
            readiness: null,
          },
          reservations: [],
          capacity: false,
        };
      });
    },
    resumeListing: (raw, context) => {
      const input = resumeListingSchema.parse(raw);
      return mutate(input, context, "ResumeListing", async (_state, operation) => {
        const authorization = await deps.authority!.authorizeResume(input, context, operation);
        assert(authorization.value, "Current pause-owner authority is required.");
        return {
          command: {
            type: "ResumeListing",
            expectedPauseReason: input.expectedPauseReason,
            inboundClamp: input.inboundClamp,
          },
          reservations: authorization.reservations,
          capacity: true,
        };
      });
    },
    readAcceptedListingTargetPrices: async (input) => {
      assert(deps.currentReads, "Listing current-read storage is unavailable.");
      return deps.currentReads.readAcceptedListingTargetPrices(input);
    },
    readNativeListingEligibility: async (input) => {
      assert(deps.currentReads, "Listing current-read storage is unavailable.");
      return deps.currentReads.readNativeListingEligibility(input);
    },
  };
  return {
    ...services,
    commitCapacity: async (
      input: Readonly<{
        accountId: string;
        listingId: string;
        quantityCap: number;
        idempotencyKey?: string;
        expectedVersion?: number;
      }>,
      context: EventStoreContext,
      requestCommand: JsonObject,
      prepare: (
        state: MarketplaceListingState,
        operation: ListingAuthorityOperation,
      ) => Promise<
        Readonly<{
          command: MarketplaceListingCommand;
          reservations: readonly ListingAuthorityReservation[];
        }>
      >,
    ) => {
      const current = await owned(input.listingId, input.accountId);
      return mutate(
        {
          ...input,
          expectedListingVersion: input.expectedVersion ?? current.version,
          idempotencyKey: input.idempotencyKey ?? `capacity:${input.listingId}:${current.version}`,
        },
        context,
        "UpdateListingQuantityCap",
        async (state, operation) => ({ ...(await prepare(state, operation)), capacity: true }),
        requestCommand,
      );
    },
    publishNative: async (
      input: Readonly<{
        accountId: string;
        listingId: string;
        idempotencyKey?: string;
        feeQuoteFingerprint?: string | null;
      }>,
      context: EventStoreContext,
    ) => {
      const current = await owned(input.listingId, input.accountId);
      const mutation: SetNativeListingVisibilityInput = {
        accountId: input.accountId,
        listingId: input.listingId,
        expectedListingVersion: current.version,
        idempotencyKey: input.idempotencyKey ?? `publish:${input.listingId}:${current.version}`,
        nativeVisibility: "enabled",
        ...(input.feeQuoteFingerprint ? { feeQuoteFingerprint: input.feeQuoteFingerprint } : {}),
      };
      return mutate(
        mutation,
        context,
        "SetNativeListingVisibility",
        async (state, operation) => ({
          ...(await deps.prepareNativeEnable(state, mutation, operation)),
          capacity: true,
        }),
        {
          type: "PublishListing",
          accountId: input.accountId,
          listingId: input.listingId,
          feeQuoteFingerprint: input.feeQuoteFingerprint ?? null,
        },
      );
    },
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
