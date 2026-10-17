// Generated from this context's route contributions by generate-link-intents.mjs.
import manifest from "../../context.json" with { type: "json" };
import { createContextLinkBuilder } from "@chase-sets/platform-runtime/link-intents";

// prettier-ignore
export const links = createContextLinkBuilder<{
  "account-desk-settings": { path: Record<string, never>; query?: never };
  "account-payout-setup": { path: Record<string, never>; query?: never };
  "account-wallet-adjustment": { path: { reference: string }; query?: never };
}>(manifest);
