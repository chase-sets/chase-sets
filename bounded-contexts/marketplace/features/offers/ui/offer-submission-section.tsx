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
  productId,
  itemTitle,
  selectedOptions,
  productSummary,
  visibleListingCount,
  errorMessage,
}: {
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
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
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
            <input type="hidden" name="productSummary" value={productSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              <Text size="sm" tone="secondary">
                {productSummary ?? "Standard product"}
              </Text>
              <Text size="sm" tone="secondary">
                Matching visible listings for this product: {visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                Offers are marketplace-wide. They are not sent to a single seller.
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
