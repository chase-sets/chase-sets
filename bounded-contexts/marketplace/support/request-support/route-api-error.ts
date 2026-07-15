import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import { MarketplaceApiError } from "../../client";

export const marketplaceApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is MarketplaceApiError =>
    error instanceof MarketplaceApiError ||
    (error instanceof Error && "status" in error && typeof error.status === "number" && "body" in error),
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
