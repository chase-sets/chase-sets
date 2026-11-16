import { marketplaceAttemptIdSchema } from "../../features/mutation-recovery/domain/contracts";
import {
  marketplaceListingCanonicalRequest,
  type MarketplaceListingMutationKind,
} from "../../features/mutation-recovery/domain/contracts";
import { hashMarketplaceRequest } from "../../features/mutation-recovery/api/attempt";

export function listingCommandInput<T extends Record<string, unknown> & { idempotencyKey: string }>(
  kind: MarketplaceListingMutationKind,
  request: T,
) {
  return {
    ...request,
    requestHash:
      typeof request.requestHash === "string"
        ? request.requestHash
        : hashMarketplaceRequest(marketplaceListingCanonicalRequest(kind, request)),
  };
}

export function listingFormAttempt(formData: FormData, command: string) {
  const key = marketplaceAttemptIdSchema.parse(formData.get("idempotencyKey"));
  return { idempotencyKey: marketplaceAttemptIdSchema.parse(`${key}_${command}`) };
}
