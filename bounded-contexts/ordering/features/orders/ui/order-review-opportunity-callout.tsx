import { t } from "@chase-sets/localization";
import { Card, LinkButton, Stack, Text } from "@chase-sets/design-system";

export type OrderReviewOpportunity = Readonly<{
  author_role: string;
  active_review_id: string | null;
}>;

function getCounterpartyRole(authorRole: string) {
  return authorRole === "buyer" ? "seller" : "buyer";
}

export function OrderReviewOpportunityCallout({
  opportunity,
  reviewHref,
  transactionLabel,
}: {
  opportunity: OrderReviewOpportunity;
  reviewHref: string;
  transactionLabel: "purchase" | "sale";
}) {
  const counterpartyRole = getCounterpartyRole(opportunity.author_role);
  const href = opportunity.active_review_id ? `/account/reviews/${opportunity.active_review_id}` : reviewHref;

  return (
    <Card>
      <Stack gap={2}>
        <Text weight="semibold">
          {opportunity.active_review_id
            ? t("ordering.features.orders.ui.orderReviewOpportunityCallout.your.account.review.is.already.active")
            : t("ordering.features.orders.ui.orderReviewOpportunityCallout.ready.for.counterparty.review", {
                transactionLabel,
                counterpartyRole,
              })}
        </Text>
        <Text size="sm" tone="secondary">
          {t("ordering.features.orders.ui.orderReviewOpportunityCallout.reviews.open.only.after.delivery.verifies")}
        </Text>
        <LinkButton href={href}>
          {opportunity.active_review_id
            ? t("ordering.features.orders.ui.orderReviewOpportunityCallout.open.your.review")
            : t("ordering.features.orders.ui.orderReviewOpportunityCallout.leave.account.review")}
        </LinkButton>
      </Stack>
    </Card>
  );
}
