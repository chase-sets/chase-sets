const retiredSellerBadgeClassTokens = ["rounded-full", "border-muted", "bg-elevated", "px-3", "py-1.5"];

/**
 * Detects the verified SellerBadge treatment removed from admin section brands by the admin-shell parity change.
 * Admin page data may legitimately contain the word "Verified", so the deployed smoke must
 * match the retired shell structure rather than treating the entire HTML response as copy.
 */
export function hasRetiredAdminVerifiedChip(html) {
  const sellerBadgePattern = /<div\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/div>/gi;

  for (const match of html.matchAll(sellerBadgePattern)) {
    const classes = new Set(match[1].split(/\s+/).filter(Boolean));
    if (
      retiredSellerBadgeClassTokens.every((token) => classes.has(token)) &&
      /<span\b[^>]*>\s*Verified\s*<\/span>/i.test(match[2])
    ) {
      return true;
    }
  }

  return false;
}
