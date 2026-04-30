import type { CheckoutSessionId } from "@chase-sets/primitives/typed-ids";

export const checkoutSeedIds = {
  sessions: {
    startedCart: "chk_seed_started_cart" as CheckoutSessionId,
  },
} as const;
