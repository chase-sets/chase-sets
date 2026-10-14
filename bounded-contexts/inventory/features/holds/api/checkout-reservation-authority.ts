import type { EventStoreContext } from "@chase-sets/event-core/storage";

export type InventoryCheckoutReservationAuthority = (
  input: Readonly<{
    checkoutSessionId: string;
    lineKey: string;
    inventoryItemId: string;
    quantity: number;
    operation?: "create" | "extend" | "release";
    context: EventStoreContext;
  }>,
) => Promise<Readonly<{ accountId: string; canMutate?: boolean }> | null>;
