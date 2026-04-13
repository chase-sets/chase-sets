import {
  Button,
  Card,
  NumberInput,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";

export function OrderingAddToCartSection({
  catalogItemId,
  catalogVersionKey,
  itemTitle,
  versionSelection,
  versionSummary,
  visibleListingCount,
  errorMessage,
}: {
  catalogItemId: string;
  catalogVersionKey: string;
  itemTitle: string;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  visibleListingCount: number;
  errorMessage?: string | null;
}) {
  return (
    <PageSection title="Add To Cart">
      <Card>
        <form method="post">
          <Stack gap={3}>
            <input type="hidden" name="intent" value="add-to-cart" />
            <input type="hidden" name="catalogItemId" value={catalogItemId} />
            <input type="hidden" name="catalogVersionKey" value={catalogVersionKey} />
            <input type="hidden" name="versionSelection" value={JSON.stringify(versionSelection)} />
            <input type="hidden" name="versionSummary" value={versionSummary ?? ""} />
            <Stack gap={1}>
              <Text weight="semibold">{itemTitle}</Text>
              <Text size="sm" tone="secondary">
                {versionSummary ?? "Standard version"}
              </Text>
              <Text size="sm" tone="secondary">
                Matching visible listings right now: {visibleListingCount}
              </Text>
              <Text size="sm" tone="secondary">
                Cart lines capture buyer intent. Exact listing and inventory matching happens at checkout.
              </Text>
            </Stack>
            {errorMessage ? <Text>{errorMessage}</Text> : null}
            <NumberInput
              label="Quantity"
              name="quantity"
              min="1"
              defaultValue="1"
              required
            />
            <Button type="submit">Add to cart</Button>
          </Stack>
        </form>
      </Card>
    </PageSection>
  );
}
