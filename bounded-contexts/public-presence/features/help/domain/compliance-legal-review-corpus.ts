/**
 * The one production membership and order manifest for the compliance Help
 * Article partition of the counsel legal-review corpus.
 *
 * Before this module the only enumeration of the five reviewed compliance
 * articles lived inside `compliance-articles.test.ts`, so nothing production
 * code could read named the partition. The counsel review packet and the
 * launch copy audit both need that membership, and neither may derive it from
 * a filename convention, a category listing, or a recalled list — a file
 * appearing in `domain/articles` is presence evidence, not a reviewed
 * decision to put a document in front of counsel.
 *
 * Membership rules this module deliberately keeps:
 *
 * - ORDER IS CONTRACT. `complianceLegalReviewArticleSlugs` is the reviewed
 *   order the packet renders and the audit reports. It is not alphabetical by
 *   coincidence and must not be re-sorted for presentation.
 * - MEMBERSHIP IS NOT INCORPORATION. A compliance member is reproduced in the
 *   packet in full. An incorporated reference is named by Terms and summarized
 *   only; it is a different obligation and lives in its own list.
 * - NO SECOND PRODUCTION LIST. `compliance-articles.test.ts` keeps its literal
 *   five-slug tuple as an independent test-only oracle for this contract, so a
 *   deletion or reorder here is detectable. That oracle is never exported and
 *   never loaded as production membership.
 *
 * This module is intentionally free of imports: the offline packet loader, the
 * live copy audit, and the launch go/no-go gate all read it directly as plain
 * data, and adding a dependency here would drag the compiled catalog into
 * scripts that only need the membership.
 */

/**
 * The compliance Help Articles reproduced in full in the counsel review
 * packet and audited as launch-required public routes, in reviewed order.
 */
export const complianceLegalReviewArticleSlugs = [
  "community-guidelines-and-enforcement",
  "intellectual-property-and-dmca",
  "prohibited-and-restricted-items",
  "sales-tax",
  "tax-reporting-1099k",
] as const;

export type ComplianceLegalReviewArticleSlug = (typeof complianceLegalReviewArticleSlugs)[number];

/**
 * Help Articles the Terms of Service incorporates by reference. They are
 * summarized in the packet as named incorporations and are NOT reproduced,
 * because counsel reviews the incorporating clause, not the operational
 * standard it points at.
 */
export const incorporatedHelpArticleSlugs = [
  "condition-and-photo-standards",
  "order-protection",
  "refunds-and-returns",
] as const;

export type IncorporatedHelpArticleSlug = (typeof incorporatedHelpArticleSlugs)[number];

/** The one locale the reviewed corpus is drafted and reviewed in. */
export const complianceLegalReviewLocale = "en";

/** The compliance member that carries the DMCA designated-agent copy. */
export const dmcaComplianceArticleSlug = "intellectual-property-and-dmca";

/**
 * The exact checked-in marker that says the Copyright Office designated-agent
 * directory probe found no matching current record. Launch cannot be reviewed
 * as complete while this marker is present in the source or on the live page;
 * removing it requires its own exact directory probe, not this manifest.
 */
export const dmcaUnverifiedRegistrationMarker = "registration-status-unverified";

export function isComplianceLegalReviewArticleSlug(value: string): value is ComplianceLegalReviewArticleSlug {
  return (complianceLegalReviewArticleSlugs as readonly string[]).includes(value);
}

export function isIncorporatedHelpArticleSlug(value: string): value is IncorporatedHelpArticleSlug {
  return (incorporatedHelpArticleSlugs as readonly string[]).includes(value);
}
