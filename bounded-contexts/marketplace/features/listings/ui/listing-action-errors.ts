import { internalErrorResponse } from "@chase-sets/http/responses";
import { marketplaceApiErrorAdapter } from "../../../support/request-support/route-api-error";
import { listingErrorFeedback } from "./listing-error-contract";

export function listingActionFeedback(error: unknown): string | null {
  return listingErrorFeedback(
    marketplaceApiErrorAdapter.getStatus(error),
    marketplaceApiErrorAdapter.getErrorCode(error),
  );
}

export function throwListingActionFailure(error: unknown): never {
  if (error instanceof Response && error.status < 400) throw error;
  const status = error instanceof Response ? error.status : marketplaceApiErrorAdapter.getStatus(error);
  throw Response.json(internalErrorResponse(), {
    status: status !== null && status >= 400 && status <= 599 ? status : 500,
  });
}
