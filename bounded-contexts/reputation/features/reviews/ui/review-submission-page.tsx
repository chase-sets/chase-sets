import { useState } from "react";
import {
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Rating,
  Stack,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type { ReviewOpportunity } from "./contracts";

function getCounterpartyRole(authorRole: string) {
  return authorRole === "buyer" ? "seller" : "buyer";
}

export function ReviewSubmissionPage({
  backHref,
  opportunity,
  errorMessage,
  isSubmitting = false,
  defaultRating = 5,
  defaultFeedback = "",
}: {
  backHref: string;
  opportunity: ReviewOpportunity;
  errorMessage?: string | null;
  isSubmitting?: boolean;
  defaultRating?: number;
  defaultFeedback?: string;
}) {
  const [rating, setRating] = useState(defaultRating);
  const counterpartyRole = getCounterpartyRole(opportunity.author_role);
  const counterpartyLabel =
    opportunity.subject_display_name ?? opportunity.subject_account_id;

  return (
    <Page>
      <PageHeader
        eyebrow="Reviews"
        title={`Review ${counterpartyLabel}`}
        description={`Leave account feedback for this ${counterpartyRole} on order ${opportunity.order_id}.`}
        actions={
          <LinkButton href={backHref} tone="secondary">
            Back
          </LinkButton>
        }
      />

      <PageSection title="Verified order">
        <Card>
          <Stack gap={2}>
            <Text>Order {opportunity.order_id}</Text>
            <Text>Counterparty: {counterpartyLabel}</Text>
            <Text size="sm" tone="secondary">
              Reviews open only after the order has been verified by delivery.
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Your review">
        <Card>
          <Stack gap={3}>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <form method="post">
              <Stack gap={3}>
                <input type="hidden" name="rating" value={rating} />
                <Stack gap={1}>
                  <Text weight="semibold">Rating</Text>
                  <Rating
                    interactive
                    label="Review rating"
                    value={rating}
                    onValueChange={setRating}
                  />
                </Stack>
                <Textarea
                  name="feedback"
                  label="Feedback"
                  defaultValue={defaultFeedback}
                  rows={5}
                  description="Tell the account what went well or what needs improvement."
                />
                <Button type="submit">
                  {isSubmitting ? "Submitting review..." : "Submit account review"}
                </Button>
              </Stack>
            </form>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
