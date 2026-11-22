import { parseJsonResponse, type FulfillmentClientTransport } from "../../../support/request-support/client";
import type { SellerShippingSetupInput } from "../domain/shipping-setup";
import type { SellerShippingSetupResult } from "./runtime";
export type { SellerShippingSetupInput, SellerShippingSetupResult };
export type SellerShippingSetupMode = "account" | "guest";

export function createSellerShippingSetupClient({
  credentials,
  directUrl,
  fetch,
  headers,
}: FulfillmentClientTransport) {
  return {
    async getSellerShippingSetup(mode: SellerShippingSetupMode): Promise<SellerShippingSetupResult> {
      return parseJsonResponse(await fetch(directUrl(`/${mode}/seller-shipping-setup`), { headers, credentials }));
    },
    async saveSellerShippingSetup(
      mode: SellerShippingSetupMode,
      input: SellerShippingSetupInput,
    ): Promise<SellerShippingSetupResult> {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Content-Type", "application/json");
      return parseJsonResponse(
        await fetch(directUrl(`/${mode}/seller-shipping-setup`), {
          method: "PUT",
          headers: requestHeaders,
          credentials,
          body: JSON.stringify(input),
        }),
      );
    },
  };
}
