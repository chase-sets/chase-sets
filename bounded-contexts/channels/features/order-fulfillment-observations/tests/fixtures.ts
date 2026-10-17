import { tcgplayerSaleKey } from "../../tcgplayer-orders/domain/contracts";
import type { ChannelOrderFulfillmentObservation } from "../domain/contracts";

// Synthetic values using only vocabulary captured in #7793 comment 5647341461.
export function fulfillmentFixture(
  orderReference = "synthetic-order",
): Extract<ChannelOrderFulfillmentObservation, { variant: "full" }> {
  const line = { productId: "202", skuId: "101", quantity: 2, unitPriceAmount: "10.00" };
  return {
    version: 1,
    variant: "full",
    providerKey: "tcgplayer",
    externalOrderReference: orderReference,
    providerOrderStatus: { surface: "list", value: "Ready to Ship" },
    orderedAt: "2026-09-12T16:56:27.225Z",
    providerShippingType: { surface: "list", value: "Expedited" },
    shipTo: {
      name: "Synthetic Recipient",
      line1: "123 Example St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    lines: [
      {
        ...line,
        providerOrderLineIdentity: tcgplayerSaleKey("account-1", "connection-1", orderReference, line)
          .orderLineIdentity,
      },
    ],
    productAmount: "20.00",
    shippingAmount: "3.00",
    currency: { code: "USD", provenance: "tcgplayer-constant" },
  };
}
