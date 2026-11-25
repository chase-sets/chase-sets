import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { GradedCardDetails, InventoryItemEvent } from "../domain/domain";
import type { InventorySelectedOptionEntry } from "../integrations/catalog/versioning";

const inventoryItemEventCodec = createPassthroughDomainEventCodec<InventoryItemEvent>();

/**
 * Read-only authority for the Graded Item Details recorded when an inventory item was created, and
 * the selection those details were written from.
 *
 * `inventory.item.created` is the first event of the item's stream and no later event changes the
 * item's account, its `gradedCard` or its `selectedOptions`, so that one event is the whole answer.
 * No projection is read, no command is issued and no event is appended.
 */
export function createInventoryItemGradedCardAuthority(pool: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool });

  return {
    async resolveInventoryItemGradedCard(
      input: Readonly<{ accountId: string; inventoryItemId: string }>,
    ): Promise<Readonly<{
      gradedCard: GradedCardDetails | null;
      selectedOptions: readonly InventorySelectedOptionEntry[];
    }> | null> {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "accountId" && key !== "inventoryItemId") ||
        typeof input.accountId !== "string" ||
        input.accountId.length === 0 ||
        typeof input.inventoryItemId !== "string" ||
        input.inventoryItemId.length === 0
      ) {
        throw new Error("Invalid inventory item graded card authority input.");
      }
      const [stored] = await eventStore.readStream({
        streamId: `inventory.item-${input.inventoryItemId}`,
        fromVersion: 1,
        limit: 1,
      });
      if (!stored) return null;
      const created = inventoryItemEventCodec.decode(stored);
      if (
        created.type !== "inventory.item.created" ||
        created.data.itemId !== input.inventoryItemId ||
        created.data.accountId !== input.accountId
      ) {
        return null;
      }
      // The passthrough codec does not re-validate a stored payload; an item recorded without a key is raw
      // and selects nothing.
      const recordedOptions: unknown = created.data.selectedOptions;
      return {
        gradedCard: created.data.gradedCard ?? null,
        selectedOptions: Array.isArray(recordedOptions)
          ? created.data.selectedOptions.map(({ dimensionId, optionId }) => ({ dimensionId, optionId }))
          : [],
      };
    },
  };
}
