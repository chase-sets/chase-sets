import { t } from "@chase-sets/localization";
import { useEffect, useState, type ReactNode } from "react";
import {
  AccordionOptionTrigger,
  FormPanel,
  type FormPanelVariant,
  PanelSectionAccordion,
  ProductOptions,
  SegmentedControl,
  Stack,
  Text,
  type IconName,
} from "@chase-sets/design-system";
import { trackItemDetailRailEvent } from "../../../../support/ui-support/item-detail-rail-analytics";
import {
  type CommerceAccordionEdge,
  type MarketSelectionSource,
  productOptionsFromSelectionDetails,
  type ProductSelectionDisplayDetail,
} from "./commerce-primitives";

type BuyAction = "buy-now" | "add-to-cart" | "make-offer";
type SellAction = "selected-offer" | "add-product-to-sell-list" | "list-for-sale";
type WatchAction = "watch-listings" | "watch-offers";

type CommerceActionOption<TAction extends string> = Readonly<{
  value: TAction;
  label: string;
  description: string;
  icon: IconName;
  disabled?: boolean;
}>;

function ItemDetailActionCard<TAction extends string>({
  title,
  description,
  productSummary,
  productSelectionDetails,
  options,
  selectedAction,
  onSelectedActionChange,
  children,
  panelVariant = "card",
  accordionEdge,
  glow = false,
  showProductSummary = true,
  footer,
}: {
  title: string;
  description: string;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  options: readonly CommerceActionOption<TAction>[];
  selectedAction: TAction | "";
  onSelectedActionChange: (action: TAction | "") => void;
  children: ReactNode;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  glow?: boolean;
  showProductSummary?: boolean;
  footer?: ReactNode;
}) {
  return (
    <FormPanel variant={panelVariant} glow={glow}>
      <Stack gap={3}>
        <Stack gap={1}>
          <Text weight="semibold">{title}</Text>
          <Text size="sm" tone="secondary">
            {description}
          </Text>
          {showProductSummary ? (
            <ProductOptions
              options={productOptionsFromSelectionDetails(productSelectionDetails)}
              emptyLabel={productSummary ?? t("discovery.routes.itemDetail.choose.options.to.select.product")}
              variant={productSelectionDetails.length === 0 ? "chips" : "inline"}
            />
          ) : null}
        </Stack>
        {footer}
        <PanelSectionAccordion
          type="single"
          edge={accordionEdge ?? (panelVariant === "plain" ? "compact" : "card")}
          value={selectedAction}
          onValueChange={(value) => {
            if (typeof value === "string") {
              const selectedOption = options.find((option) => option.value === value);

              if (selectedOption?.disabled) {
                return;
              }

              onSelectedActionChange(value as TAction | "");
            }
          }}
          items={options.map((option) => ({
            value: option.value,
            disabled: option.disabled,
            trigger: (
              <AccordionOptionTrigger
                icon={option.icon}
                title={option.label}
                description={option.description}
                active={selectedAction === option.value}
                disabled={option.disabled}
              />
            ),
            content: selectedAction === option.value ? children : null,
          }))}
        />
      </Stack>
    </FormPanel>
  );
}

export function BuyActionCard({
  formIdPrefix,
  panelVariant = "card",
  accordionEdge,
  productId,
  productSummary,
  productSelectionDetails,
  visibleListingCount,
  hasSelectedListing,
  selectedListingSource = "implicit",
  renderBuyNow,
  renderAddToCart,
  renderOffer,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  visibleListingCount: number;
  hasSelectedListing?: boolean;
  selectedListingSource?: MarketSelectionSource;
  renderBuyNow: (formId: string) => ReactNode;
  renderAddToCart: (formId: string) => ReactNode;
  renderOffer: (formId: string) => ReactNode;
}) {
  const defaultAction: BuyAction = productId && visibleListingCount > 0 ? "buy-now" : "make-offer";
  const [selectedAction, setSelectedAction] = useState<BuyAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const listingWorkflowLabel =
    hasSelectedListing && selectedListingSource === "explicit"
      ? t("discovery.features.itemDetail.ui.itemDetailPage.selected.listing")
      : t("discovery.routes.itemDetail.best.available.listing");
  const listingWorkflowDescription =
    hasSelectedListing && selectedListingSource === "explicit"
      ? t("discovery.routes.itemDetail.selected.listing.workflow.helper")
      : t("discovery.routes.itemDetail.best.available.listing.workflow.helper");
  const options = [
    {
      value: "buy-now",
      label: listingWorkflowLabel,
      description: listingWorkflowDescription,
      icon: "creditCard",
      disabled: !productId || visibleListingCount === 0,
    },
    {
      value: "add-to-cart",
      label: t("discovery.routes.itemDetail.selected.product"),
      description: t("discovery.routes.itemDetail.add.to.cart.workflow.helper"),
      icon: "cart",
      disabled: !productId,
    },
    {
      value: "make-offer",
      label: t("discovery.routes.itemDetail.make.an.offer"),
      description: t("discovery.routes.itemDetail.make.offer.action.description"),
      icon: "tag",
      disabled: !productId,
    },
  ] satisfies readonly CommerceActionOption<BuyAction>[];
  const selectedContent =
    selectedAction === "buy-now"
      ? renderBuyNow(`${formIdPrefix}-buy-now`)
      : selectedAction === "add-to-cart"
        ? renderAddToCart(`${formIdPrefix}-add-to-cart`)
        : selectedAction === "make-offer"
          ? renderOffer(`${formIdPrefix}-make-offer`)
          : null;
  const handleSelectedActionChange = (action: BuyAction | "") => {
    setSelectedAction(action);

    if (!action) {
      return;
    }

    trackItemDetailRailEvent("workflow_selected", {
      intent: "buy",
      workflow:
        action === "buy-now"
          ? hasSelectedListing && selectedListingSource === "explicit"
            ? "selected_listing"
            : "best_available_listing"
          : action === "add-to-cart"
            ? "selected_product"
            : "make_offer",
      selection: action === "buy-now" && hasSelectedListing ? selectedListingSource : "none",
      surface: "action_rail",
    });
  };

  return (
    <ItemDetailActionCard
      title={t("discovery.routes.itemDetail.buy.card.title")}
      description={t("discovery.routes.itemDetail.buy.card.description")}
      productSummary={productSummary}
      productSelectionDetails={productSelectionDetails}
      options={options}
      selectedAction={selectedAction}
      onSelectedActionChange={handleSelectedActionChange}
      panelVariant={panelVariant}
      accordionEdge={accordionEdge}
      glow={visibleListingCount > 0}
      showProductSummary={false}
    >
      {selectedContent}
    </ItemDetailActionCard>
  );
}

export function SellActionCard({
  formIdPrefix,
  panelVariant = "card",
  accordionEdge,
  productId,
  productSummary,
  productSelectionDetails,
  hasMatchingOffer,
  canSelectListingAction = true,
  canSelectProductSellListAction = canSelectListingAction,
  selectedOfferSource = "implicit",
  renderSelectedOffer,
  renderAddProductToSellList,
  renderListing,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  hasMatchingOffer: boolean;
  canSelectListingAction?: boolean;
  canSelectProductSellListAction?: boolean;
  selectedOfferSource?: MarketSelectionSource;
  renderSelectedOffer: (formId: string) => ReactNode;
  renderAddProductToSellList: (formId: string) => ReactNode;
  renderListing: (formId: string) => ReactNode;
}) {
  const defaultAction: SellAction | "" = hasMatchingOffer
    ? "selected-offer"
    : canSelectProductSellListAction
      ? "add-product-to-sell-list"
      : canSelectListingAction
        ? "list-for-sale"
        : "";
  const [selectedAction, setSelectedAction] = useState<SellAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const selectedOfferWorkflowLabel =
    selectedOfferSource === "explicit"
      ? t("discovery.routes.itemDetail.selected.offer.heading")
      : t("discovery.routes.itemDetail.best.offer.heading");
  const options = [
    {
      value: "selected-offer",
      label: selectedOfferWorkflowLabel,
      description: t("discovery.routes.itemDetail.selected.offer.workflow.helper"),
      icon: "dollar",
      disabled: !productId || !hasMatchingOffer,
    },
    {
      value: "add-product-to-sell-list",
      label: t("discovery.routes.itemDetail.selected.product"),
      description: t("discovery.routes.itemDetail.add.product.to.sell.list.action.description"),
      icon: "spark",
      disabled: !productId || !canSelectProductSellListAction,
    },
    {
      value: "list-for-sale",
      label: t("discovery.routes.itemDetail.sell.on.chase.sets"),
      description: t("discovery.routes.itemDetail.list.for.sale.action.description"),
      icon: "store",
      disabled: !productId || !canSelectListingAction,
    },
  ] satisfies readonly CommerceActionOption<SellAction>[];
  const selectedContent =
    selectedAction === "selected-offer"
      ? renderSelectedOffer(`${formIdPrefix}-selected-offer`)
      : selectedAction === "add-product-to-sell-list"
        ? renderAddProductToSellList(`${formIdPrefix}-product-sell-list`)
        : selectedAction === "list-for-sale"
          ? renderListing(`${formIdPrefix}-list-for-sale`)
          : null;
  const handleSelectedActionChange = (action: SellAction | "") => {
    setSelectedAction(action);

    if (!action) {
      return;
    }

    trackItemDetailRailEvent("workflow_selected", {
      intent: "sell",
      workflow:
        action === "selected-offer"
          ? selectedOfferSource === "explicit"
            ? "selected_offer"
            : "best_offer"
          : action === "add-product-to-sell-list"
            ? "selected_product"
            : "create_listing",
      selection: action === "selected-offer" ? selectedOfferSource : "none",
      surface: "action_rail",
    });
  };

  return (
    <ItemDetailActionCard
      title={t("discovery.routes.itemDetail.sell.card.title")}
      description={t("discovery.routes.itemDetail.sell.card.description")}
      productSummary={productSummary}
      productSelectionDetails={productSelectionDetails}
      options={options}
      selectedAction={selectedAction}
      onSelectedActionChange={handleSelectedActionChange}
      panelVariant={panelVariant}
      accordionEdge={accordionEdge}
      glow={hasMatchingOffer}
      showProductSummary={false}
    >
      {selectedContent}
    </ItemDetailActionCard>
  );
}

export function WatchActionCard({
  formIdPrefix,
  panelVariant = "card",
  accordionEdge,
  productId,
  productSummary,
  productSelectionDetails,
  renderListingAlert,
  renderOfferAlert,
}: {
  formIdPrefix: string;
  panelVariant?: FormPanelVariant;
  accordionEdge?: CommerceAccordionEdge;
  productId: string | null;
  productSummary: string | null;
  productSelectionDetails: readonly ProductSelectionDisplayDetail[];
  renderListingAlert: (formId: string) => ReactNode;
  renderOfferAlert: (formId: string) => ReactNode;
}) {
  const defaultAction: WatchAction = "watch-listings";
  const [selectedAction, setSelectedAction] = useState<WatchAction | "">(defaultAction);

  useEffect(() => {
    setSelectedAction(defaultAction);
  }, [defaultAction]);

  const options = [
    {
      value: "watch-listings",
      label: t("discovery.routes.itemDetail.watch.listings"),
      description: t("discovery.routes.itemDetail.watch.listings.description"),
      icon: "bell",
      disabled: !productId,
    },
    {
      value: "watch-offers",
      label: t("discovery.routes.itemDetail.watch.offers"),
      description: t("discovery.routes.itemDetail.watch.offers.description"),
      icon: "eye",
      disabled: !productId,
    },
  ] satisfies readonly CommerceActionOption<WatchAction>[];
  const selectedContent =
    selectedAction === "watch-offers"
      ? renderOfferAlert(`${formIdPrefix}-offer-alert`)
      : selectedAction === "watch-listings"
        ? renderListingAlert(`${formIdPrefix}-listing-alert`)
        : null;
  const handleSelectedActionChange = (action: WatchAction | "") => {
    setSelectedAction(action);

    if (!action) {
      return;
    }

    trackItemDetailRailEvent("workflow_selected", {
      intent: "watch",
      workflow: action === "watch-offers" ? "watch_offers" : "watch_listings",
      selection: "none",
      surface: "action_rail",
    });
  };

  return (
    <ItemDetailActionCard
      title={t("discovery.routes.itemDetail.watch")}
      description={t("discovery.routes.itemDetail.watch.card.description")}
      productSummary={productSummary}
      productSelectionDetails={productSelectionDetails}
      options={options}
      selectedAction={selectedAction}
      onSelectedActionChange={handleSelectedActionChange}
      panelVariant={panelVariant}
      accordionEdge={accordionEdge}
      showProductSummary={false}
    >
      {selectedContent}
    </ItemDetailActionCard>
  );
}

export function ItemCommercePanel({
  buyer,
  seller,
  watch,
  showSellerTab,
}: {
  buyer: ReactNode;
  seller: ReactNode;
  watch?: ReactNode;
  showSellerTab: boolean;
}) {
  const [mode, setMode] = useState<"buy" | "sell" | "watch">("buy");

  return (
    <Stack gap={3}>
      {showSellerTab ? (
        <SegmentedControl
          items={[
            { value: "buy", label: t("discovery.routes.itemDetail.buy") },
            { value: "sell", label: t("discovery.routes.itemDetail.sell") },
            { value: "watch", label: t("discovery.routes.itemDetail.watch") },
          ]}
          value={mode}
          onValueChange={(value) => setMode(value === "sell" ? "sell" : value === "watch" ? "watch" : "buy")}
        />
      ) : null}
      {mode === "watch" && watch ? watch : mode === "sell" && showSellerTab ? seller : buyer}
    </Stack>
  );
}
