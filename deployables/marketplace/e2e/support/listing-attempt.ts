import { randomUUID } from "node:crypto";
import { listingCommandInput } from "@chase-sets/marketplace/server";

export function listingTestCommand(kind: Parameters<typeof listingCommandInput>[0], request: Record<string, unknown>) {
  return listingCommandInput(kind, {
    ...request,
    idempotencyKey: typeof request.idempotencyKey === "string" ? request.idempotencyKey : `e2e_listing_${randomUUID()}`,
  });
}
