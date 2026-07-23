import { supportSeedIds } from "@chase-sets/platform-operations/server";
import { centsToMoneyAmount } from "@chase-sets/primitives/money";

export const marketplaceBrowserE2eSeedContract = {
  buyer: {
    email: "collector@chasesets.test",
    password: "collector1234",
  },
  seller: {
    email: "demo@chasesets.test",
    password: "demo1234",
  },
  cart: {
    lineCount: 2,
    startedSessionId: "chk_seed_started_cart",
  },
  // Pinned item identity for responsive/evidence claims. A generic search query is
  // ambiguous between cat_seed_charizard_base_set and
  // cat_seed_japanese_charizard_base_set (contracts/catalog-seed/ids.ts), and the
  // Japanese item has no seeded listings. The route is the deterministic slug
  // createMarketplaceSlug(["Charizard", "Base Set 4/102 Holo Rare"], catalogItemId)
  // (bounded-contexts/discovery/support/runtime-support/slugs.ts) resolves to for the
  // seeded title/subtitle in bounded-contexts/catalog/features/catalog-items/api/seed.ts.
  itemDetail: {
    catalogItemId: "cat_seed_charizard_base_set",
    routePath: "/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp",
    // Form=Raw + Condition=Near Mint (contracts/catalog-seed/ids.ts dim_seed_form /
    // dim_seed_condition) is the exact combination the catalog seed pins a listing
    // reference to (bounded-contexts/catalog/features/catalog-items/api/seed.ts
    // externalProductReferences), so deep-linking it via the
    // readInitialSelectedOptions `dimension.<id>` query contract
    // (bounded-contexts/discovery/support/route-support/item-detail/support.ts)
    // completes product selection deterministically without depending on UI
    // interaction order or unseeded dimension combinations.
    selectedProductRoutePath:
      "/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp?dimension.dim_seed_form=chc_seed_form_raw&dimension.dim_seed_condition=chc_seed_condition_near_mint",
  },
  // Pinned identity for the dock's no-product-selected state. It is not reachable on the
  // charizard route: useItemDetailPageModel resolves selectedProductId implicitly from
  // the best visible listing
  // (bounded-contexts/discovery/features/item-detail/ui/use-item-detail-page-model.tsx),
  // so any item with seeded listings renders the product-selected Buy/Sell/Watch dock.
  // cat_seed_bulbasaur_base_set is the item the catalog seed maintains as the
  // "no-listings-and-no-offers case"
  // (bounded-contexts/catalog/features/catalog-items/api/seed.ts): it carries the full
  // pokemon-card-single product schema but zero market listings and zero offer demand
  // matches, which is exactly the shape the Discovery unit suite pins for the
  // single full-width "Select options" dock.
  itemDetailWithoutListings: {
    catalogItemId: "cat_seed_bulbasaur_base_set",
    routePath: "/items/bulbasaur-base-set-44-102-common-seed-bulbasaur-base-set-ok08ju",
  },
  support: {
    damagedItemAgreement: {
      supportRequestId: supportSeedIds.supportRequests.selfServiceProductDamaged,
      partialRefundAmount: centsToMoneyAmount(500),
      currencyCode: "USD",
    },
  },
} as const;

export function marketplaceBrowserE2eBuyerCredentials() {
  const email = process.env.MARKETPLACE_E2E_EMAIL?.trim() || marketplaceBrowserE2eSeedContract.buyer.email;
  const password = process.env.MARKETPLACE_E2E_PASSWORD?.trim() || marketplaceBrowserE2eSeedContract.buyer.password;

  if (!email || !password) {
    throw new Error(
      "Marketplace buyer journey requires MARKETPLACE_E2E_EMAIL and MARKETPLACE_E2E_PASSWORD or the browser-e2e seed buyer contract.",
    );
  }

  return { email, password };
}

export function marketplaceBrowserE2eSellerCredentials() {
  const email = process.env.MARKETPLACE_E2E_SELLER_EMAIL?.trim() || marketplaceBrowserE2eSeedContract.seller.email;
  const password =
    process.env.MARKETPLACE_E2E_SELLER_PASSWORD?.trim() || marketplaceBrowserE2eSeedContract.seller.password;

  if (!email || !password) {
    throw new Error(
      "Marketplace seller journey requires MARKETPLACE_E2E_SELLER_EMAIL and MARKETPLACE_E2E_SELLER_PASSWORD or the browser-e2e seed seller contract.",
    );
  }

  return { email, password };
}
