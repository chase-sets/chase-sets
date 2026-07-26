import type { CheckoutSessionId } from "@chase-sets/primitives/typed-ids";

export const checkoutSeedIds = {
  sessions: {
    startedCart: "chk_seed_started_cart" as CheckoutSessionId,
  },
  // Reserved cart line ids. The seed authors cart lines against the
  // `checkout.cart-*` stream, so each line needs an id that is stable across
  // boots rather than one generated per call and deduplicated through the
  // UNLOGGED `checkout_cart_line_pages` projection.
  cartLines: {
    demoCharizardBaseSetNearMint: "cli_seed_demo_charizard_base_set_near_mint",
    demoPikachuJungleExcellent: "cli_seed_demo_pikachu_jungle_excellent",
  },
} as const;
