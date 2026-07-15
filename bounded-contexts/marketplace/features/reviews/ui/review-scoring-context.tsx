import { t } from "@chase-sets/localization";
import { ReviewContext } from "@chase-sets/design-system";

export type PublicReviewScoringContext = Readonly<{
  scoring_disposition?: "included" | "context-only" | null;
  disposition_reason_code?: string | null;
  resolution_context?: "seller" | "buyer" | "carrier" | "platform" | "shared" | "undetermined" | null;
  remedy_kind?: "refund" | "replacement" | "return" | "cancellation" | null;
}>;

function outcomeLabel(context: PublicReviewScoringContext) {
  switch (context.resolution_context) {
    case "carrier":
      return t("reputation.features.reviews.ui.reviewScoringContext.carrier");
    case "platform":
      return t("reputation.features.reviews.ui.reviewScoringContext.platform");
    case "shared":
    case "undetermined":
      return t("reputation.features.reviews.ui.reviewScoringContext.sharedOrUndetermined");
    case "seller":
    case "buyer":
      return t("reputation.features.reviews.ui.reviewScoringContext.supportResolved");
    default:
      return context.disposition_reason_code && context.disposition_reason_code !== "normal-completion"
        ? t("reputation.features.reviews.ui.reviewScoringContext.supportResolved")
        : undefined;
  }
}

function remedyLabel(remedyKind: PublicReviewScoringContext["remedy_kind"]) {
  switch (remedyKind) {
    case "refund":
      return t("reputation.features.reviews.ui.reviewScoringContext.remedy.refund");
    case "replacement":
      return t("reputation.features.reviews.ui.reviewScoringContext.remedy.replacement");
    case "return":
      return t("reputation.features.reviews.ui.reviewScoringContext.remedy.return");
    case "cancellation":
      return t("reputation.features.reviews.ui.reviewScoringContext.remedy.cancellation");
    default:
      return undefined;
  }
}

export function ReviewScoringContext({ review }: { review: PublicReviewScoringContext }) {
  if (!review.scoring_disposition) {
    return null;
  }

  const included = review.scoring_disposition === "included";
  return (
    <ReviewContext
      scoringStatus={included ? "included" : "excluded"}
      scoringLabel={
        included
          ? t("reputation.features.reviews.ui.reviewScoringContext.included")
          : t("reputation.features.reviews.ui.reviewScoringContext.excluded")
      }
      explanation={
        included
          ? t("reputation.features.reviews.ui.reviewScoringContext.included.description")
          : t("reputation.features.reviews.ui.reviewScoringContext.excluded.description")
      }
      outcomeLabel={outcomeLabel(review)}
      remedyLabel={remedyLabel(review.remedy_kind)}
    />
  );
}
