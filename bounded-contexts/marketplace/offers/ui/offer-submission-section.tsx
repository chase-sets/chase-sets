import {
  Button,
  Card,
  NumberInput,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";

export function MarketplaceOfferSubmissionSection({
  catalogItemId,
  itemTitle,
  versionSelection,
  versionSummary,
  visibleListingCount,
  errorMessage,
}: {
  catalogItemId: string;
  itemTitle: string;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  return (
    <PageSection title="Make An Offer">
      <Card>
        <form method="post">
          <Stack gap={3}>
            <input type="hidden" name="intent" value="submit-offer" />
            <input type="hidden" name="catalogItemId" value={catalogItemId} />
            <input type="hidden" name="versionSelection" value={JSON.stringify(versionSelection)} />
            <input type="hidden" name="versionSummary" value={versionSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              <Text size="sm" tone="secondary">
                {versionSummary ?? "Standard version"}
              </Text>
              <Text size="sm" tone="secondary">
                Matching visible listings for this version: {visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                Offers are marketplace-wide in v1. They are not sent to a single seller.
              </Text>
            </Stack>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <TextInput
              label="Offer price"
              name="priceAmount"
              placeholder="24.99"
              inputMode="decimal"
              required
            />
            <NumberInput
              label="Quantity requested"
              name="quantityRequested"
              min="1"
              required
            />
            <Button type="submit">Submit offer</Button>
          </Stack>
        </form>
      </Card>
    </PageSection>
  );
}
