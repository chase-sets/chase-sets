import { t } from "@chase-sets/localization";
import { useEffect, type ReactNode } from "react";
import {
  HiddenInput,
  Form,
  Button,
  CurrencyInput,
  FormPanel,
  type FormPanelVariant,
  Inline,
  LinkButton,
  NumberField,
  ProductOptions,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { DiscoveryMarketListing } from "../../../../support/client-support/contracts";
import { trackItemDetailRailEvent } from "../item-detail-rail-analytics";
import {
  productOptionsFromSelectionDetails,
  type ProductSelectionDisplayDetail,
  RailReferenceInfo,
} from "./commerce-primitives";

export function ListingStockShipFromSetupSection({
  formId,
  errorMessage,
}: {
  formId: string;
  errorMessage?: string | null;
}) {
  return (
    <FormPanel variant="card">
      <Form spacing="none" id={formId} method="post">
        <Stack gap={3}>
          <HiddenInput type="hidden" name="intent" value="create-listing-stock-location" />
          <Stack gap={1}>
            <Text weight="semibold">{t("discovery.routes.itemDetail.ship.from.setup")}</Text>
            <Text size="sm" tone="secondary">
              {t("discovery.routes.itemDetail.ship.from.setup.description")}
            </Text>
          </Stack>
          <TextInput label={t("discovery.routes.itemDetail.ship.from.name")} name="shipFromName" required />
          <TextInput label={t("discovery.routes.itemDetail.ship.from.line1")} name="shipFromLine1" required />
          <Inline>
            <TextInput label={t("discovery.routes.itemDetail.ship.from.city")} name="shipFromCity" required />
            <TextInput label={t("discovery.routes.itemDetail.ship.from.state")} name="shipFromState" required />
          </Inline>
          <Inline>
            <TextInput
              label={t("discovery.routes.itemDetail.ship.from.postal.code")}
              name="shipFromPostalCode"
              required
            />
            <TextInput
              label={t("discovery.routes.itemDetail.ship.from.country")}
              name="shipFromCountry"
              defaultValue="US"
              required
            />
          </Inline>
          {errorMessage ? <Text>{errorMessage}</Text> : null}
          <Button type="submit" block>
            {t("discovery.routes.itemDetail.save.ship.from.setup")}
          </Button>
        </Stack>
      </Form>
    </FormPanel>
  );
}

export function MarketplaceListingSubmissionSection({
  formId = "list-box",
  panelVariant = "card",
  showSummary = panelVariant === "card",
  actions,
  productId,
  selectedOptions,
  productSummary,
  productSelectionDetails = [],
  bestListing,
  ownListing,
  hasListingStockLocation,
  listingSetupLoadState = hasListingStockLocation ? "ready" : "missing",
  allowDraftWithoutShipFromSetup = false,
  errorMessage,
}: {
  formId?: string;
  panelVariant?: FormPanelVariant;
  showSummary?: boolean;
  actions?: ReactNode;
  productId: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  productSelectionDetails?: readonly ProductSelectionDisplayDetail[];
  bestListing: {
    listing_id: string;
    inventory_item_id: string;
    product_id: string;
    price_amount: string;
    quantity_cap: number;
    status: string;
  } | null;
  ownListing: DiscoveryMarketListing | null;
  hasListingStockLocation: boolean;
  listingSetupLoadState?: "not-applicable" | "ready" | "missing" | "fresh-write-recovering" | "load-failed";
  allowDraftWithoutShipFromSetup?: boolean;
  errorMessage?: string | null;
}) {
  const listing = ownListing ?? null;
  const listPrice = listing?.price_amount ?? bestListing?.price_amount ?? "";
  const defaultQuantity = listing?.quantity_cap ?? 1;
  const requiresShipFromSetup = !listing && !hasListingStockLocation && !allowDraftWithoutShipFromSetup;
  const canCreateShipFromSetup = requiresShipFromSetup && listingSetupLoadState === "missing";
  const canUseListAction = Boolean(productId && !requiresShipFromSetup);
  const defaultActions = listing ? (
    <LinkButton href={`/account/listings/${listing.listing_id}`} block>
      {t("discovery.routes.itemDetail.manage.listing")}
    </LinkButton>
  ) : (
    <Button type="submit" name="intent" value="list-at-price" disabled={!canUseListAction} block>
      {t("discovery.routes.itemDetail.list.for.sale")}
    </Button>
  );
  useEffect(() => {
    if (!errorMessage) {
      return;
    }

    trackItemDetailRailEvent("validation_failed", {
      intent: "sell",
      workflow: "create_listing",
      topic: "create_listing",
      outcome: "form_error",
      surface: "action_rail",
    });
  }, [errorMessage]);

  const form = (
    <Form
      spacing="none"
      id={formId}
      method="post"
      onSubmit={() => {
        trackItemDetailRailEvent("intent_submit_started", {
          intent: "sell",
          workflow: "create_listing",
          topic: "create_listing",
          surface: "action_rail",
        });
      }}
    >
      <Stack gap={3}>
        <HiddenInput type="hidden" name="productId" value={productId ?? ""} />
        <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <HiddenInput type="hidden" name="productSummary" value={productSummary ?? ""} />
        <HiddenInput type="hidden" name="listingId" value={listing?.listing_id ?? ""} />
        {showSummary ? (
          <Stack gap={1}>
            <Text weight="semibold">
              {listing
                ? t("discovery.routes.itemDetail.update.your.listing")
                : t("discovery.routes.itemDetail.sell.on.chase.sets")}
            </Text>
            {productSelectionDetails.length > 0 ? (
              <ProductOptions
                options={productOptionsFromSelectionDetails(productSelectionDetails)}
                emptyLabel={
                  productSummary ?? t("discovery.routes.itemDetail.choose.options.to.list.matching.inventory")
                }
              />
            ) : (
              <Text size="sm" tone="secondary">
                {productSummary
                  ? t("discovery.routes.itemDetail.selling.product", { productSummary })
                  : t("discovery.routes.itemDetail.choose.options.to.list.matching.inventory")}
              </Text>
            )}
            {listing ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.your.listing.summary", {
                  status: listing.status,
                  price: listing.price_amount,
                })}
              </Text>
            ) : bestListing ? (
              <Text size="sm" tone="secondary">
                {t("discovery.routes.itemDetail.current.best.listing.summary", {
                  price: bestListing.price_amount,
                })}
              </Text>
            ) : null}
            <RailReferenceInfo
              analyticsTopic="create_listing"
              triggerLabel={t("discovery.routes.itemDetail.referenceInfo.createListing.trigger")}
              ariaLabel={t("discovery.routes.itemDetail.referenceInfo.createListing.aria")}
              title={t("discovery.routes.itemDetail.referenceInfo.createListing.title")}
              summary={t("discovery.routes.itemDetail.referenceInfo.createListing.summary")}
              lines={[
                t("discovery.routes.itemDetail.referenceInfo.createListing.line1"),
                t("discovery.routes.itemDetail.referenceInfo.createListing.line2"),
              ]}
            />
          </Stack>
        ) : null}
        {listing ? <HiddenInput type="hidden" name="inventoryItemId" value={listing.inventory_item_id} /> : null}
        {listing ? (
          <>
            <HiddenInput type="hidden" name="priceAmount" value={listPrice} />
            <HiddenInput type="hidden" name="quantityCap" value={String(defaultQuantity)} />
          </>
        ) : (
          <>
            <CurrencyInput
              label={t("discovery.routes.itemDetail.listing.price")}
              name="priceAmount"
              currencyCode="USD"
              defaultValue={listPrice || undefined}
              placeholder="24.99"
              min="0"
              step="0.01"
              required
            />
            <NumberField
              label={t("discovery.routes.itemDetail.quantity")}
              name="quantityCap"
              min={1}
              defaultValue={defaultQuantity}
              required
            />
          </>
        )}
        {!listing && requiresShipFromSetup ? (
          <Text size="sm" tone="secondary">
            {listingSetupLoadState === "fresh-write-recovering" && errorMessage
              ? errorMessage
              : t("discovery.routes.itemDetail.ship.from.setup.required")}
          </Text>
        ) : null}
        {errorMessage && listingSetupLoadState !== "fresh-write-recovering" ? <Text>{errorMessage}</Text> : null}
        {actions !== undefined ? actions : defaultActions}
      </Stack>
    </Form>
  );

  return (
    <Stack gap={3}>
      <FormPanel variant={panelVariant} glow={Boolean(listing)}>
        {form}
      </FormPanel>
      {canCreateShipFromSetup ? (
        <ListingStockShipFromSetupSection formId={`${formId}-ship-from-setup`} errorMessage={errorMessage} />
      ) : null}
    </Stack>
  );
}
