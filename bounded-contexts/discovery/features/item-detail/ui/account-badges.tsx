import { t } from "@chase-sets/localization";
import { TrustBadge } from "@chase-sets/design-system";

/**
 * Buyer-facing badge display (m87 badge facts, m108 reputation). Discovery
 * mirrors only the identity Account Badge keys meaningful to a buyer
 * looking at a seller -- "trusted-seller" -- not the full
 * `identity/features/accounts/domain/domain.ts` vocabulary (founding-account
 * and manual-payout-review are operator/internal-facing, never shown here).
 * Lives in item-detail (its only in-context slice consumer;
 * `routes/public-account.tsx` also renders it as a composition-root import)
 * rather than importing identity's UI package: discovery does not depend on
 * identity (`allowedContextDependencies`), and the badge FACT already flows
 * here via discovery's own identity event subscription
 * (support/market-support/projection.ts).
 *
 * Explainer deviation: the AC calls for a link to the published
 * trusted-seller policy from m107. That policy page has not shipped
 * yet (same "badge portion degrades gracefully" posture the public-profile
 * milestone already established for this exact gap) -- the explainer is
 * plain text via the badge's title/tooltip today; wire the link in once the
 * published-policy page lands.
 */
const BUYER_FACING_BADGE_KEY = "trusted-seller";

export function hasTrustedSellerBadge(badges: readonly string[] | undefined): boolean {
  return Boolean(badges?.includes(BUYER_FACING_BADGE_KEY));
}

export function TrustedSellerBadge() {
  const label = t("discovery.features.itemDetail.ui.accountBadges.trusted.seller");
  const explainer = t("discovery.features.itemDetail.ui.accountBadges.trusted.seller.explainer");
  return (
    <TrustBadge tone="policy" title={explainer}>
      {label}
    </TrustBadge>
  );
}
