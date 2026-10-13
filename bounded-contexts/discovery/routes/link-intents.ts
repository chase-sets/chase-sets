// Generated from this context's route contributions by generate-link-intents.mjs.
import manifest from "../context.json" with { type: "json" };
import { createContextLinkBuilder } from "@chase-sets/platform-runtime/link-intents";

// prettier-ignore
export const links = createContextLinkBuilder<{
  "category": { path: { categorySlug: string }; query?: never };
  "item-detail": { path: { id: string }; query?: { market?: "sell" | "buy" } };
  "public-listing": { path: { listingSlug: string }; query?: never };
  "public-account": { path: { accountSlug: string }; query?: never };
  "set": { path: { setSlug: string }; query?: never };
  "search": { path: Record<string, never>; query?: never };
}>(manifest);
