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
  const href = opportunity.active_review_id
    ? `/account/reviews/${opportunity.active_review_id}`
    : reviewHref;

  return (
    <Card>
      <Stack gap={2}>
        <Text weight="semibold">
          {opportunity.active_review_id
            ? "Your account review is already active."
            : `This verified ${transactionLabel} is ready for your ${counterpartyRole} counterparty review.`}
        </Text>
        <Text size="sm" tone="secondary">
          Reviews open only after delivery verifies both accounts in the transaction.
        </Text>
        <LinkButton href={href}>
          {opportunity.active_review_id ? "Open your review" : "Leave account review"}
        </LinkButton>
      </Stack>
    </Card>
  );
}
