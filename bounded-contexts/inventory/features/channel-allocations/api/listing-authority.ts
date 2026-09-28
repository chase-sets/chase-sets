import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { ListingAuthorityConsumerPort, ListingAuthorityOperation } from "@chase-sets/event-core/listing-authority";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { toJsonValue } from "@chase-sets/primitives/json";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import { createListingAuthorityRecovery } from "@chase-sets/platform-runtime/listing-authority-recovery";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { loadAuthoritativeInventoryStockSnapshot } from "../../../support/runtime-support/stock-snapshot";
import { type InventoryHoldId, InventoryDomainError } from "../../../support/runtime-support/common";
import { createInventoryHoldRuntime } from "../../holds/api/runtime";
import {
  decideInventoryHold,
  evolveInventoryHold,
  initialInventoryHoldState,
  type InventoryHoldEvent,
} from "../../holds/domain/domain";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
} from "../../inventory-items/domain/domain";
import { channelStockAllocationStreamId } from "../domain/allocation";
import { createInventoryChannelStockAllocationRuntime } from "./runtime";

export type InventoryListingAuthorityConsumer = (operation: ListingAuthorityOperation) => ListingAuthorityConsumerPort;

/** Item-scoped predicates include new holds and an as-yet absent allocation. */
export function createInventoryListingAuthority(
  deps: InventoryRuntimeDeps,
  consumer: InventoryListingAuthorityConsumer,
) {
  const itemCodec = createPassthroughDomainEventCodec<InventoryItemEvent>();
  const holdCodec = createPassthroughDomainEventCodec<InventoryHoldEvent>();
  const { repository: items } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: itemCodec,
    initialState: () => initialInventoryItemState,
    evolve: evolveInventoryItem,
    decide: decideInventoryItem,
  });
  const { repository: holds } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: holdCodec,
    initialState: () => initialInventoryHoldState,
    evolve: evolveInventoryHold,
    decide: decideInventoryHold,
  });
  const allocations = createInventoryChannelStockAllocationRuntime(deps);
  const holdPlans = createInventoryHoldRuntime(deps);
  const resource = (accountId: string, itemId: string) => `stock/${accountId}/${itemId}`;
  const holdId = (operation: ListingAuthorityOperation) =>
    `hld_${createHash("sha256").update(operation.operationId).digest("hex")}` as InventoryHoldId;

  const source = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    participant: { owner: "inventory", purpose: "stock-allocation" },
    resourceScope: "owner",
    consumer,
    resources: (operation) => [resource(operation.accountId, operation.subject.inventoryItemId)],
    validate: async (operation, context) => {
      const subject = operation.subject;
      const item = await items.load(`inventory.item-${subject.inventoryItemId}`);
      if (
        item.state.id !== subject.inventoryItemId ||
        item.state.accountId !== operation.accountId ||
        item.state.catalogItemId !== subject.catalogItemId ||
        item.state.productId !== subject.productId ||
        JSON.stringify(item.state.selectedOptions) !== JSON.stringify(subject.selectedOptions) ||
        !Number.isSafeInteger(subject.quantity) ||
        subject.quantity < 1
      ) {
        throw new InventoryDomainError("Listing does not identify owned Inventory Product stock.");
      }
      const stock = await loadAuthoritativeInventoryStockSnapshot({
        db: deps.db,
        itemRepository: items,
        itemAggregate: item,
        itemId: subject.inventoryItemId,
        accountId: operation.accountId as AccountId,
        context,
      });
      const allocation = await allocations.readAuthoritative({
        accountId: operation.accountId,
        inventoryItemId: subject.inventoryItemId,
      });
      if (
        !("mode" in allocation) ||
        (subject.allocationRevision !== null && subject.allocationRevision !== allocation.revision)
      ) {
        throw new InventoryDomainError("Listing Channel Stock Allocation is not current.");
      }
      const target = operation.target;
      const partition =
        target.kind === "channel-connection"
          ? allocation.partitions.find((entry) => entry.channelConnectionId === target.connectionId)
          : null;
      const eligibleQuantity =
        operation.target.kind === "channel-connection" && allocation.mode !== "shared-pool"
          ? Math.min(stock.availableQuantity, partition?.units ?? 0)
          : stock.availableQuantity;
      if (eligibleQuantity < subject.quantity)
        throw new InventoryDomainError("Listing exceeds current sellable Inventory stock.");
      let localAppends: readonly AppendToStreamInput[] = [
        { streamId: `inventory.item-${subject.inventoryItemId}`, expectedVersion: item.version, context, events: [] },
        {
          streamId: channelStockAllocationStreamId(subject.inventoryItemId),
          expectedVersion: allocation.revision,
          context,
          events: [],
        },
      ];
      if (operation.kind === "native-commitment") {
        // The committing owner supplies its real Offer or Order identity. Activation
        // never reaches this branch and therefore never creates a stock hold.
        if (!subject.commitmentSourceId) {
          throw new InventoryDomainError("A purchase hold requires its final Offer or Order commitment identity.");
        }
        const plan = await holdPlans.planCreateHold(
          {
            holdId: holdId(operation),
            accountId: operation.accountId as AccountId,
            itemId: subject.inventoryItemId,
            quantity: subject.quantity,
            reason: "Native purchase commitment",
            purpose: operation.committingOwner === "ordering" ? "order" : "offer",
            sourceRef:
              operation.committingOwner === "ordering"
                ? { orderId: subject.commitmentSourceId, reservationRequestId: operation.requestId }
                : { offerId: subject.commitmentSourceId, reservationRequestId: operation.requestId },
          },
          context,
        );
        if (plan.kind !== "append")
          throw new InventoryDomainError("Purchase hold exists without its source reservation.");
        localAppends = [...plan.appends, localAppends[1]!];
      }
      return {
        value: {
          accountId: operation.accountId,
          inventoryItemId: subject.inventoryItemId,
          catalogItemId: subject.catalogItemId,
          productId: subject.productId,
          availableQuantity: stock.availableQuantity,
          allocationRevision: allocation.revision,
          eligibleQuantity,
          allocation: toJsonValue(allocation),
          holdId: operation.kind === "native-commitment" ? holdId(operation) : null,
        },
        sourceRevisions: [
          { resourceId: `inventory.item-${subject.inventoryItemId}`, revision: String(item.version) },
          {
            resourceId: channelStockAllocationStreamId(subject.inventoryItemId),
            revision: String(allocation.revision),
          },
        ],
        validBefore: operation.prepareBefore,
        localAppends,
      };
    },
    settlementAppends: async (operation, status, context) => {
      if (status === "consumed" || operation.kind !== "native-commitment") return [];
      const streamId = `inventory.hold-${holdId(operation)}`;
      const hold = await holds.load(streamId);
      if (
        !hold.state.id ||
        hold.state.accountId !== operation.accountId ||
        hold.state.itemId !== operation.subject.inventoryItemId
      ) {
        throw new InventoryDomainError("Purchase reservation lost its authoritative Inventory hold.");
      }
      if (hold.state.status !== "active") return [];
      return [
        {
          streamId,
          expectedVersion: hold.version,
          context,
          events: decideInventoryHold(hold.state, {
            type: "ReleaseInventoryHold",
            releasedAt: new Date().toISOString(),
            releaseReason: "superseded",
          }).map(holdCodec.encode),
        },
      ];
    },
  });

  const writer = createListingAuthorityWriter({
    eventStore: deps.eventStore,
    source,
    owner: "inventory",
    resources: async (inputs) => {
      const affected = new Set<string>();
      for (const input of inputs) {
        if (!input.events.length) continue;
        let itemId: string | null = null;
        let accountId: string = input.context.audit.forAccountId;
        if (input.streamId.startsWith("inventory.item-")) itemId = input.streamId.slice("inventory.item-".length);
        else if (input.streamId.startsWith("inventory.channel-stock-allocation-")) {
          itemId = input.streamId.slice("inventory.channel-stock-allocation-".length);
        } else if (input.streamId.startsWith("inventory.hold-")) {
          const created =
            input.events.find((event) => event.eventType === "inventory.hold.placed") ??
            (await readCompleteStream(deps.eventStore, { streamId: input.streamId }))[0];
          if (!created || typeof created.payload.itemId !== "string" || typeof created.payload.accountId !== "string") {
            throw new InventoryDomainError("Hold mutation has no authoritative Inventory owner.");
          }
          itemId = created.payload.itemId;
          accountId = created.payload.accountId;
        }
        if (itemId) {
          const item = await items.load(`inventory.item-${itemId}`);
          const owners = new Set<string>();
          if (item.state.accountId) owners.add(item.state.accountId);
          for (const event of input.events) {
            if (typeof event.payload.accountId === "string") owners.add(event.payload.accountId);
          }
          if (!owners.size) throw new InventoryDomainError("Stock mutation has no authoritative Inventory owner.");
          if (input.streamId.startsWith("inventory.hold-")) owners.add(accountId);
          for (const owner of owners) affected.add(resource(owner, itemId));
        }
      }
      return [...affected];
    },
  });
  return {
    source,
    ...writer,
    recover: createListingAuthorityRecovery({
      db: deps.db,
      owner: "inventory",
      sources: [source],
      consumer,
      resume: writer.resume,
      resumeWrite: writer.resumeWrite,
    }),
  };
}
