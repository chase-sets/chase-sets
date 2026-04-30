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
  { label: "buyer-offer path or module name", pattern: /\bbuyer-offer\b/i },
  { label: "seller-offer path or module name", pattern: /\bseller-offer\b/i },
  { label: "account-buyer-offers route test", pattern: /\baccount-buyer-offers\b/i },
];

const accountCapabilityLanguageGuardRoots = [
  "bounded-contexts/",
  "deployables/",
  "docs/",
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
