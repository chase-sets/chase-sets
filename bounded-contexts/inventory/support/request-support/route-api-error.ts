import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import { InventoryApiError } from "../../features/storage-locations/api/transport";

export const inventoryApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is InventoryApiError =>
    error instanceof InventoryApiError ||
    (error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error),
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
