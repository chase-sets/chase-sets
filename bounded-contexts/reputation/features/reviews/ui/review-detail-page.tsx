import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { ReviewDetail } from "./contracts";

function statusTone(status: string) {
  return status === "withdrawn" ? "danger" : "success";
}

export function ReviewDetailPage({
  backHref,
  review,
}: {
  backHref: string;
  review: ReviewDetail;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Review"
        title={`Review ${review.review_id}`}
        description={`Order ${review.order_id}`}
        actions={
          <LinkButton href={backHref} tone="secondary">
            Back
          </LinkButton>
        }
      />

      <PageSection title="Summary">
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(review.status)}>{review.status}</Badge>
            <Text>Rating: {review.rating} / 5</Text>
            <Text>Author role: {review.author_role}</Text>
            <Text>
              Author: {review.author_display_name ?? review.author_account_id}
            </Text>
            <Text>
              Subject: {review.subject_display_name ?? review.subject_account_id}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Feedback">
        <Card>
          <Text>{review.feedback ?? "No written feedback."}</Text>
        </Card>
      </PageSection>
    </Page>
  );
}
