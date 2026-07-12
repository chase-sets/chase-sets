import { t } from "@chase-sets/localization";
import { TrustBadge } from "@chase-sets/design-system";

/**
 * Buyer-facing badge display (m87 badge facts, m108 reputation). Discovery
 * mirrors only the identity Account Badge keys meaningful to a buyer looking
 * at a seller -- "trusted-seller" and "founding-account" -- not the full
 * `identity/features/accounts/domain/domain.ts` vocabulary
 * (`manual-payout-review` is operator/internal-facing, never shown here).
 * Lives in item-detail (its only in-context slice consumer;
 * `routes/public-account.tsx` also renders it as a composition-root import)
 * rather than importing identity's UI package: discovery does not depend on
 * identity (`allowedContextDependencies`), and the badge FACT already flows
 * here via discovery's own identity event subscription
 * (support/market-support/projection.ts).
 *
 * `founding-account` was operator/internal-only until the founder badge went
 * buyer-facing: the founder badge is the founders-offer activation
 * incentive, so visibility is the point -- this reverses that half of the
 * original ruling. `manual-payout-review` is unaffected and stays internal.
 *
 * Explainer deviation: the acceptance criteria for both badges call for a
 * link to a published policy/terms page (the trusted-seller policy, the
 * founders-offer terms page). Neither page has shipped yet -- same "badge
 * portion degrades gracefully" posture the public-profile milestone already
 * established -- so both explainers are plain text via the badge's
 * title/tooltip today; wire the links in once the respective pages land.
 *
 * The founder number is carried by Identity's badge-assigned fact and mirrored
 * beside the badge key so every buyer-facing surface renders the same number.
 */
const TRUSTED_SELLER_BADGE_KEY = "trusted-seller";
const FOUNDER_BADGE_KEY = "founding-account";

export function hasTrustedSellerBadge(badges: readonly string[] | undefined): boolean {
  return Boolean(badges?.includes(TRUSTED_SELLER_BADGE_KEY));
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

export function hasFounderBadge(badges: readonly string[] | undefined): boolean {
  return Boolean(badges?.includes(FOUNDER_BADGE_KEY));
}

export function FounderBadge({ founderNumber }: { founderNumber?: number | null }) {
  const baseLabel = t("discovery.features.itemDetail.ui.accountBadges.founder");
  const label = founderNumber ? `${baseLabel} #${String(founderNumber).padStart(3, "0")}` : baseLabel;
  const explainer = t("discovery.features.itemDetail.ui.accountBadges.founder.explainer");
  return <TrustBadge title={explainer}>{label}</TrustBadge>;
}
