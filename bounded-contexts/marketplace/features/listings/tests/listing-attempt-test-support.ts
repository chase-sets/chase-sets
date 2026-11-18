import type { Env, Hono } from "hono";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { listingRecoveryForCommand } from "../api/listing-recovery";
import {
  marketplaceListingCanonicalRequest,
  type MarketplaceListingMutationKind,
} from "../../mutation-recovery/domain/contracts";

export function listingTestCommand<T extends Record<string, unknown>>(
  kind: MarketplaceListingMutationKind,
  request: T,
) {
  return {
    ...request,
    idempotencyKey:
      typeof request.idempotencyKey === "string" ? request.idempotencyKey : `test_attempt_${crypto.randomUUID()}`,
    requestHash:
      typeof request.requestHash === "string"
        ? request.requestHash
        : hashMarketplaceRequest(marketplaceListingCanonicalRequest(kind, request)),
  };
}

export function listingBulkTestCommand<const T extends { updates: readonly Record<string, unknown>[] }>(request: T) {
  return { ...request, updates: request.updates.map((update) => listingTestCommand("listing.update-price", update)) };
}

export function listingPreparationResponse(init: RequestInit | undefined, accountId: string) {
  const identity = listingRecoveryForCommand(JSON.parse(String(init?.body)), accountId);
  if (!identity) return Response.json({ reference: null });
  const { batchId, mutationKind, bulk } = identity;
  return Response.json({ reference: { batchId, mutationKind, bulk } });
}

/**
 * Route fixtures that predate the Listing attempt carrier send each command once with a fresh attempt, exactly
 * as a browser form does. Attempt semantics (missing key, replay, conflict) are proved by the dedicated
 * listing-attempt tests, never through this helper.
 */
export function sendListingCommandsWithFreshAttempts<E extends Env>(app: Hono<E>): Hono<E> {
  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && !c.req.raw.headers.has("Idempotency-Key"))
      c.req.raw.headers.set("Idempotency-Key", `test_attempt_${crypto.randomUUID()}`);
    await next();
  });
  return app;
}
