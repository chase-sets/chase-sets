import type { InventoryServices } from "./services";
import { createInventoryRequestApiClient } from "./server";
export type { InventoryRecordListItem } from "./client";

export type InventoryReservationPort = Readonly<{
  createReservation: (input: {
    sellerAccountId: string;
    inventoryRecordId: string;
    quantity: number;
    reason: string;
    notes?: string | null;
    context: unknown;
  }) => Promise<{
    holdId: string;
    inventoryRecordId: string;
    sellerAccountId: string;
    quantity: number;
  }>;
  releaseReservation: (input: {
    sellerAccountId: string;
    holdId: string;
    context: unknown;
  }) => Promise<void>;
}>;

export function createInventoryReservationGateway(
  services: InventoryServices,
): InventoryReservationPort {
  return {
    createReservation: async ({ sellerAccountId, inventoryRecordId, quantity, reason, notes, context }) => {
      const result = await services.holds.createHold(
        {
          accountId: sellerAccountId as never,
          recordId: inventoryRecordId as never,
          quantity,
          reason,
          notes,
        },
        context as never,
      );

      return {
        holdId: result.holdId,
        inventoryRecordId: inventoryRecordId as never,
        sellerAccountId: sellerAccountId as never,
        quantity,
      };
    },
    releaseReservation: async ({ sellerAccountId, holdId, context }) => {
      await services.holds.releaseHold(
        {
          accountId: sellerAccountId as never,
          holdId: holdId as never,
        },
        context as never,
      );
    },
  };
}

export function createInventoryRecordLookupPort(request: Request) {
  const api = createInventoryRequestApiClient(request);

  return {
    listRecords(query = "") {
      return api.listRecords(query);
    },
  };
}
