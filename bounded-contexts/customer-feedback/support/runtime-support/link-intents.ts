// Generated from this context's route contributions by generate-link-intents.mjs.
import manifest from "../../context.json" with { type: "json" };
import { createContextLinkBuilder } from "@chase-sets/platform-runtime/link-intents";

// prettier-ignore
export const links = createContextLinkBuilder<{
  "customer-feedback-attention": { path: Record<string, never>; query?: { caseId?: string } };
}>(manifest);
