import { defineApiErrorAdapter } from "@chase-sets/platform-runtime/http";
import { PricingApiError } from "./api-client";

export const pricingApiErrorAdapter = defineApiErrorAdapter({
  isError: (error): error is PricingApiError => error instanceof PricingApiError,
  getStatus: (error) => error.status,
  getBody: (error) => error.body,
});
