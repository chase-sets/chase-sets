import { createInventoryClientTransport } from "../../../support/request-support/client";
import {
  inventoryRequestOptions,
  type InventoryRequestClientOptions,
} from "../../../support/request-support/request-options";
import { createStorageLocationClient } from "./client";

export function createStorageLocationRequestClient(request: Request, options?: InventoryRequestClientOptions) {
  return createStorageLocationClient(createInventoryClientTransport(inventoryRequestOptions(request, options)));
}
