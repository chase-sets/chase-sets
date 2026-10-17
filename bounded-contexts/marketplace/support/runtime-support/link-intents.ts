// Generated from this context's route contributions by generate-link-intents.mjs.
import manifest from "../../context.json" with { type: "json" };
import { createContextLinkBuilder } from "@chase-sets/platform-runtime/link-intents";

// prettier-ignore
export const links = createContextLinkBuilder<{
  "account-listings": { path: Record<string, never>; query?: never };
  "account-purchase-review": { path: { purchaseId: string }; query?: never };
  "account-review": { path: { reviewId: string }; query?: never };
  "account-sale-review": { path: { orderId: string }; query?: never };
}>(manifest);
