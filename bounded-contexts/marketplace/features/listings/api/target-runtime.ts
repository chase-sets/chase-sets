import { createId } from "@chase-sets/primitives/typed-ids";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { assertConfigurationGrantVector } from "@chase-sets/event-core/configuration-epoch";
import { assertRequestTerminalBinding } from "@chase-sets/event-core/owner-stream-reservation";
import { reservationIdentity } from "@chase-sets/event-core/owner-stream-reservation";
import { z } from "zod";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import {
  listingPriceTargetKey,
  normalizeAcceptedListingPrice,
  type AcceptedListingTargetPriceV1,
} from "../domain/target-price";
import {
  acceptListingTargetPriceSchema,
  activateListingForChannelSchema,
  readAcceptedListingTargetPricesSchema,
} from "./target-validation";
import type {
  ListingConfigurationAuthority,
  ListingAuthorizationEvidence,
  ListingMutationResult,
  ListingTargetAuthority,
  ListingTargetServices,
} from "./target-contracts";
import { createListingRequestExecutor } from "./listing-request";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function configurationAuthority(value: ListingConfigurationAuthority, keys: readonly string[]) {
  assert(
    value.grants.length === keys.length && keys.every((key) => value.grants.some((grant) => grant.key === key)),
    "Configuration grant manifest is incomplete.",
  );
  assertConfigurationGrantVector(value.grants);
  assert(new Set(value.evidence.map((e) => e.key)).size === value.evidence.length, "Duplicate authorization evidence.");
  const evidenceKeys = keys.flatMap((key) =>
    key.startsWith("session/") ? [key, `session-token/${key.slice(8)}`] : [key],
  );
  assert(
    value.evidence.length === evidenceKeys.length && value.evidence.every((e) => evidenceKeys.includes(e.key)),
    "Authorization evidence manifest is incomplete.",
  );
  for (const grant of value.grants) {
    const evidence = value.evidence.find((e) => e.key === grant.key);
    const owner = grant.key.startsWith("session/")
      ? "auth"
      : grant.key.startsWith("connection/")
        ? "channels"
        : "identity";
    assert(
      evidence &&
        evidence.owner === owner &&
        evidence.promiseId === undefined &&
        evidence.storeIncarnation === grant.sourceIncarnation &&
        evidence.epoch === grant.epoch &&
        Number.isSafeInteger(evidence.sealVersion) &&
        evidence.sealVersion > 0,
      "Configuration evidence is incomplete.",
    );
    if (grant.key.startsWith("session/")) {
      const token = value.evidence.find((e) => e.key === `session-token/${grant.key.slice(8)}`);
      assert(
        grant.validUntil &&
          token &&
          token.owner === "auth" &&
          token.promiseId === undefined &&
          token.epoch === grant.epoch &&
          token.storeIncarnation === grant.sourceIncarnation &&
          Number.isSafeInteger(token.sealVersion) &&
          token.sealVersion > 0,
        "Session Token evidence is incomplete.",
      );
    }
  }
}

export function createListingTargetRuntime(
  deps: Readonly<{ eventStore: EventStore; authority?: ListingTargetAuthority }>,
): ListingTargetServices {
  const execute = createListingRequestExecutor(deps.eventStore);
  const codec = createPassthroughDomainEventCodec<MarketplaceListingEvent>();
  async function owned(input: Readonly<{ listingId: string; accountId: string }>, tenantId?: string) {
    const history = await readCompleteStream(deps.eventStore, {
      streamId: `marketplace.listing-${input.listingId}`,
      maxEvents: 10000,
    });
    assert(tenantId === undefined || history.every((event) => event.tenantId === tenantId), "Foreign Listing history.");
    const state = history.reduce(
      (state, event) => evolveMarketplaceListing(state, codec.decode(event)),
      initialMarketplaceListingState,
    );
    assert(state?.listingId === input.listingId && state.accountId === input.accountId, "Listing not found.");
    return {
      state,
      version: history.length,
      createdAt: new Date(history[0]!.recordedAt).toISOString(),
      basePriceRevision: history.reduce(
        (revision, event) => (event.eventType === "marketplace.listing.price-updated" ? event.streamVersion : revision),
        1,
      ),
    };
  }
  function parseResult(value: unknown): ListingMutationResult {
    assert(value && typeof value === "object", "Missing Listing result.");
    const shape = z
      .object({
        listingId: z.string().min(1),
        version: z.number().int().positive(),
        state: z.custom<MarketplaceListingState>(
          (value) =>
            !!value &&
            typeof value === "object" &&
            "listingId" in value &&
            "acceptedTargetPrices" in value &&
            "channelActivations" in value,
        ),
      })
      .parse(value);
    assert(shape.state.listingId === shape.listingId, "Foreign Listing result.");
    return shape;
  }
  return {
    async acceptListingTargetPrice(raw, context, principal) {
      const input = acceptListingTargetPriceSchema.parse(raw);
      const pair = normalizeAcceptedListingPrice(input.priceAmount, input.priceCurrencyCode);
      const pricing = input.decision.kind === "pricing-evaluation" ? deps.authority?.pricing : undefined;
      return execute({
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
        command: { ...input, ...pair },
        context,
        principal,
        ...(input.decision.kind === "pricing-evaluation"
          ? {
              checkEvidence: (evidence: readonly ListingAuthorizationEvidence[]) => {
                const entries = evidence.filter((entry) => entry.owner === "pricing");
                assert(
                  entries.length === 4 &&
                    entries.some(
                      (entry) => entry.key === `repricing-account/${input.accountId}` && entry.epoch !== undefined,
                    ) &&
                    entries.some(
                      (entry) =>
                        entry.key === "repricing-platform-policy/pricing.repricing-engine" && entry.epoch !== undefined,
                    ) &&
                    entries.some(
                      (entry) =>
                        entry.key.startsWith('predicate:["repricing-decision"') && entry.promiseId !== undefined,
                    ) &&
                    entries.some(
                      (entry) => entry.key.startsWith('predicate:["repricing-budget"') && entry.promiseId !== undefined,
                    ) &&
                    new Set(entries.map((entry) => entry.storeIncarnation)).size === 1,
                  "Pricing decision authority is incomplete.",
                );
              },
              ...(pricing ? { settle: pricing.settle } : {}),
            }
          : {}),
        parseResult(value) {
          const result = parseResult(value);
          const accepted = result.state.acceptedTargetPrices[listingPriceTargetKey(input.target)];
          assert(
            result.listingId === input.listingId &&
              result.state.accountId === input.accountId &&
              accepted &&
              accepted.accountId === input.accountId &&
              accepted.listingId === input.listingId &&
              reservationIdentity(accepted.target) === reservationIdentity(input.target) &&
              reservationIdentity(accepted.decision) === reservationIdentity(input.decision) &&
              accepted.priceAmount === pair.priceAmount &&
              accepted.priceCurrencyCode === pair.priceCurrencyCode &&
              accepted.targetPriceRevision === input.expectedTargetPriceRevision + 1 &&
              result.version === input.expectedListingVersion + 1,
            "Corrupt acceptance result.",
          );
          return { ...result, acceptedTargetPrice: accepted };
        },
        prepare: async (preparation) => {
          assert(input.decision.kind === "seller-reference" || pricing, "Pricing decision authority is unavailable.");
          assert(input.target.kind === "channel-connection", "Only channel target acceptance is enrolled.");
          assert(
            deps.authority &&
              context.audit.forAccountId === input.accountId &&
              context.audit.performedByUserId === principal.userId,
            "Listing authority is unavailable.",
          );
          await deps.authority.recoverRequest(preparation);
          const manage = await deps.authority.authorizeManage({ accountId: input.accountId, principal }, context);
          configurationAuthority(manage, [
            `session/${principal.sessionId}`,
            `account/${input.accountId}`,
            `user/${principal.userId}`,
            `membership/${principal.membershipId}`,
          ]);
          const connection = await deps.authority.resolveConnection({
            accountId: input.accountId,
            connectionId: input.target.connectionId,
          });
          configurationAuthority(connection, [`connection/${input.target.connectionId}`]);
          const loaded = await owned(input, context.tenantId);
          assert(loaded.version === input.expectedListingVersion, "Listing revision changed.");
          const pricingPreparation =
            input.decision.kind === "pricing-evaluation" && pricing
              ? await pricing.prepare(
                  {
                    ...preparation,
                    input: { ...input, ...pair, target: input.target, decision: input.decision },
                    principal,
                    listing: loaded.state,
                    createdAt: loaded.createdAt,
                    basePriceRevision: loaded.basePriceRevision,
                  },
                  context,
                )
              : undefined;
          const pricingEvidence: ListingAuthorizationEvidence[] = [];
          if (pricingPreparation) {
            const { terminal, grants, evidenceHash } = pricingPreparation;
            assertRequestTerminalBinding(terminal);
            const pricingReservations = terminal.reservations.filter(
              ({ purpose }) => purpose === "pricing-evaluated-decision" || purpose === "pricing-daily-change-budget",
            );
            assert(
              /^[a-f0-9]{64}$/.test(evidenceHash) &&
                terminal.preparationNotBefore &&
                terminal.requestId === preparation.requestId &&
                terminal.commandFingerprint === preparation.commandFingerprint &&
                terminal.target.evidenceHash === evidenceHash &&
                terminal.target.accountId === input.accountId &&
                terminal.target.listingId === input.listingId &&
                terminal.target.productId === loaded.state.productId &&
                terminal.target.priceAmount === pair.priceAmount &&
                terminal.target.priceCurrencyCode === pair.priceCurrencyCode &&
                reservationIdentity(terminal.target.target) === reservationIdentity(input.target) &&
                reservationIdentity(terminal.target.decision) === reservationIdentity(input.decision) &&
                grants.length === 2 &&
                grants.every(
                  (grant) =>
                    grant.consumer.storeId === terminal.consumerStoreId &&
                    grant.consumer.incarnation === terminal.consumerIncarnation,
                ) &&
                pricingReservations.length === 2 &&
                new Set(pricingReservations.map((r) => r.purpose)).size === 2,
              "Pricing decision authority is incomplete.",
            );
            pricingEvidence.push(
              ...grants.map((grant) => ({
                owner: "pricing",
                key: grant.key,
                storeIncarnation: grant.sourceIncarnation,
                sealVersion: grant.epoch + 1,
                epoch: grant.epoch,
              })),
              ...pricingReservations.map((member) => ({
                owner: "pricing",
                key: member.ownerStreamId,
                storeIncarnation: member.seal.storeIncarnation,
                sealVersion: member.seal.version,
                promiseId: member.reservationId,
              })),
            );
          }
          const grants = assertConfigurationGrantVector([
            ...manage.grants,
            ...connection.grants,
            ...(pricingPreparation?.grants ?? []),
          ]);
          const eventId = createId("evt");
          const accepted: AcceptedListingTargetPriceV1 = {
            schemaVersion: 1,
            accountId: input.accountId,
            listingId: input.listingId,
            target: input.target,
            ...pair,
            targetPriceRevision: input.expectedTargetPriceRevision + 1,
            listingRevision: loaded.version + 1,
            acceptedByUserId: principal.userId,
            acceptedAt: new Date().toISOString(),
            sourceEventId: eventId,
            decision: input.decision,
            connectionAuthority: connection.connection,
          };
          const events = decideMarketplaceListing(loaded.state, {
            type: "AcceptListingTargetPrice",
            acceptedTargetPrice: accepted,
            ...(pricingPreparation ? { pricingEvidenceHash: pricingPreparation.evidenceHash } : {}),
            expectedTargetPriceRevision: input.expectedTargetPriceRevision,
          });
          const state = events.reduce(evolveMarketplaceListing, loaded.state);
          return {
            result: {
              listingId: input.listingId,
              version: loaded.version + events.length,
              state,
              acceptedTargetPrice: accepted,
            },
            evidence: [...manage.evidence, ...connection.evidence, ...pricingEvidence],
            appends: [
              {
                streamId: `marketplace.listing-${input.listingId}`,
                expectedVersion: loaded.version,
                context,
                configurationGrants: grants,
                ...(pricingPreparation ? { requestTerminal: pricingPreparation.terminal } : {}),
                events: events.map((event) => ({ ...codec.encode(event), eventId })),
              },
            ],
          };
        },
      });
    },
    async activateListingForChannel(raw, context, principal) {
      const input = activateListingForChannelSchema.parse(raw);
      return execute({
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
        command: input,
        context,
        principal,
        parseResult(value) {
          const result = parseResult(value);
          assert(
            result.listingId === input.listingId &&
              result.state.accountId === input.accountId &&
              result.state.status === "active" &&
              result.version === input.expectedListingVersion + 1 &&
              result.state.channelActivations[input.connectionId]?.revision === input.expectedTargetPriceRevision,
            "Corrupt activation result.",
          );
          return result;
        },
        prepare: async (preparation) => {
          assert(
            deps.authority &&
              context.audit.forAccountId === input.accountId &&
              context.audit.performedByUserId === principal.userId,
            "Listing authority is unavailable.",
          );
          await deps.authority.recoverRequest(preparation);
          const manage = await deps.authority.authorizeManage({ accountId: input.accountId, principal }, context);
          configurationAuthority(manage, [
            `session/${principal.sessionId}`,
            `account/${input.accountId}`,
            `user/${principal.userId}`,
            `membership/${principal.membershipId}`,
          ]);
          const connection = await deps.authority.resolveConnection({
            accountId: input.accountId,
            connectionId: input.connectionId,
          });
          configurationAuthority(connection, [`connection/${input.connectionId}`]);
          const loaded = await owned(input, context.tenantId);
          assert(loaded.version === input.expectedListingVersion, "Listing revision changed.");
          const accepted =
            loaded.state.acceptedTargetPrices[
              listingPriceTargetKey({ kind: "channel-connection", connectionId: input.connectionId })
            ];
          assert(
            accepted?.connectionAuthority &&
              reservationIdentity(accepted.connectionAuthority) === reservationIdentity(connection.connection),
            "Accepted connection authority changed.",
          );
          const events = decideMarketplaceListing(loaded.state, {
            type: "ActivateListingForChannel",
            connectionId: input.connectionId,
            expectedTargetPriceRevision: input.expectedTargetPriceRevision,
            allocationRevision: input.allocationRevision,
          });
          assert(
            loaded.state.inventoryItemId && loaded.state.catalogItemId && loaded.state.productId,
            "Listing stock identity is incomplete.",
          );
          const allocation = await deps.authority.prepareAllocation(
            {
              ...preparation,
              accountId: input.accountId,
              listingId: input.listingId,
              inventoryItemId: loaded.state.inventoryItemId,
              catalogItemId: loaded.state.catalogItemId,
              productId: loaded.state.productId,
              selectedOptions: loaded.state.selectedOptions,
              connectionId: input.connectionId,
              allocationRevision: input.allocationRevision,
            },
            context,
          );
          assertRequestTerminalBinding(allocation.terminal);
          assert(
            allocation.terminal.requestId === preparation.requestId &&
              allocation.terminal.commandFingerprint === preparation.commandFingerprint,
            "Request terminal binding changed.",
          );
          assert(
            reservationIdentity(allocation.reservations) === reservationIdentity(allocation.terminal.reservations) &&
              allocation.reservations.length === 2,
            "Inventory reservation manifest changed.",
          );
          const target = {
            listingId: input.listingId,
            accountId: input.accountId,
            inventoryItemId: loaded.state.inventoryItemId,
            channelConnectionId: input.connectionId,
            catalogItemId: loaded.state.catalogItemId,
            productId: loaded.state.productId,
            selectedOptions: loaded.state.selectedOptions,
          };
          assert(
            reservationIdentity(allocation.terminal.target) === reservationIdentity(target),
            "Inventory target binding changed.",
          );
          assert(allocation.evidence.length === 2, "Inventory evidence is incomplete.");
          for (const [index, stream] of [
            `inventory.channel-stock-allocation-${loaded.state.inventoryItemId}`,
            `inventory.item-${loaded.state.inventoryItemId}`,
          ].entries()) {
            const reservation = allocation.reservations[index];
            const evidence = allocation.evidence.find((value) => value.promiseId === reservation.reservationId);
            assert(
              reservation.ownerStreamId === stream &&
                reservation.resourceKey === `stock/${input.accountId}/${loaded.state.inventoryItemId}` &&
                reservation.seal.version > 0 &&
                evidence?.key === stream &&
                evidence.owner === "inventory" &&
                evidence.epoch === undefined &&
                evidence.storeIncarnation === reservation.seal.storeIncarnation &&
                evidence.sealVersion === reservation.seal.version,
              "Inventory evidence binding changed.",
            );
          }
          const grants = assertConfigurationGrantVector([...manage.grants, ...connection.grants]);
          return {
            result: {
              listingId: input.listingId,
              version: loaded.version + events.length,
              state: events.reduce(evolveMarketplaceListing, loaded.state),
            },
            evidence: [...manage.evidence, ...connection.evidence, ...allocation.evidence],
            appends: [
              {
                streamId: `marketplace.listing-${input.listingId}`,
                expectedVersion: loaded.version,
                context,
                configurationGrants: grants,
                requestTerminal: allocation.terminal,
                events: events.map(codec.encode),
              },
            ],
          };
        },
      });
    },
    async readAcceptedListingTargetPrices(raw) {
      const { accountId, targets } = readAcceptedListingTargetPricesSchema.parse(raw);
      const results = [];
      const listings = new Map<string, Awaited<ReturnType<typeof owned>>>();
      for (const { listingId, target } of targets) {
        let loaded = listings.get(listingId);
        if (!loaded) {
          loaded = await owned({ accountId, listingId });
          listings.set(listingId, loaded);
        }
        results.push({
          listingId,
          target,
          acceptedTargetPrice: loaded.state.acceptedTargetPrices[listingPriceTargetKey(target)] ?? null,
          activationRevision:
            target.kind === "channel-connection"
              ? (loaded.state.channelActivations[target.connectionId]?.revision ?? null)
              : null,
          listingRevision: loaded.version,
        });
      }
      return results;
    },
  };
}
