export const accountCapabilityLanguageGuardExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
]);

export const accountCapabilityLanguageGuards = [
  { label: "/buyer route namespace", pattern: /\/buyer(?:\/|["'`]|$)/ },
  { label: "/seller route namespace", pattern: /\/seller(?:\/|["'`]|$)/ },
  { label: "client.buyer", pattern: /\bclient\.buyer\b/ },
  { label: "client.seller", pattern: /\bclient\.seller\b/ },
  { label: "buyer-only", pattern: /\bbuyer-only\b/i },
  { label: "seller-only", pattern: /\bseller-only\b/i },
  {
    label: "buyer account capability classification",
    pattern: /\bbuyer\s+account\s+(?:type|classification|category|capability|status)\b/i,
  },
  {
    label: "seller account capability classification",
    pattern: /\bseller\s+account\s+(?:type|classification|category|capability|status)\b/i,
  },
  { label: "buyer capability", pattern: /\bbuyer\s+capability\b/i },
  { label: "seller capability", pattern: /\bseller\s+capability\b/i },
  { label: "SubmittedBuyerOffer", pattern: /\bSubmittedBuyerOffer\b/ },
  { label: "BuyerOfferMatch", pattern: /\bBuyerOfferMatch\b/ },
  { label: "buyer_offer_matches", pattern: /\bbuyer_offer_matches\b/i },
  { label: "discovery_buyer_offer_matches", pattern: /\bdiscovery_buyer_offer_matches\b/i },
  { label: "buyer-offer path or module name", pattern: /\bbuyer-offer\b/i },
  { label: "seller-offer path or module name", pattern: /\bseller-offer\b/i },
  { label: "seller profile primitive", pattern: /\bSellerProfile[A-Z]\w*\b/ },
  { label: "verified seller badge primitive", pattern: /\bVerifiedSellerBadge\b/ },
  { label: "buyer protection badge primitive", pattern: /\bBuyerProtectionBadge\b/ },
  { label: "buyer protection module primitive", pattern: /\bBuyerProtectionModule\b/ },
  { label: "seller quality indicator primitive", pattern: /\bSellerQualityIndicator\b/ },
  { label: "seller-performance-kpi", pattern: /\bseller-performance-kpi\b/i },
  { label: "buyer-protection route or module", pattern: /\bbuyer-protection\b/i },
  { label: "seller-fees route or module", pattern: /\bseller-fees\b/i },
  { label: "WaitlistRole", pattern: /\bWaitlistRole\b/ },
  { label: "low-seller-fees", pattern: /\blow-seller-fees\b/i },
  { label: "Buyer dashboard", pattern: /\bBuyer dashboard\b/ },
  { label: "account-buyer-offers route test", pattern: /\baccount-buyer-offers\b/i },
];

const accountCapabilityLanguageGuardRoots = [
  "bounded-contexts/",
  "contracts/",
  "deployables/",
  "docs/",
  "packages/",
];

export function isAccountCapabilityLanguageGuardedFile(relativeFile, extension) {
  return (
    accountCapabilityLanguageGuardExtensions.has(extension) &&
    accountCapabilityLanguageGuardRoots.some((root) => relativeFile.startsWith(root))
  );
}

export function findAccountCapabilityLanguageViolations({ relativeFile, content }) {
  return accountCapabilityLanguageGuards.filter(
    (guard) => guard.pattern.test(relativeFile) || guard.pattern.test(content),
  );
}
