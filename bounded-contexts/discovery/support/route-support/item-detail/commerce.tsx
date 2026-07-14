import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import type { FormPanelVariant } from "@chase-sets/design-system";
import type {
  ItemDetailCommerceSections,
  ItemDetailMarketplaceSectionContext,
} from "../../../features/item-detail/ui/item-detail-page";
import {
  BuyActionCard,
  CheckoutPurchaseIntentSection,
  type CommerceAccordionEdge,
  MarketplaceListingSubmissionSection,
  MarketplaceOfferMatchSection,
  MarketplaceOfferSubmissionSection,
  MarketplaceSellerRegistrationSection,
  ProductAlertCreationSection,
  ProductSellListIntentSection,
  WatchActionCard,
  SellActionCard,
} from "../../../features/item-detail/ui/commerce-sections";
import type { DiscoveryItemDetailRouteData, DiscoveryItemDetailActionData } from "./types";
import { AddToSavedListControl } from "../../../features/saved-list-addition/ui/add-to-saved-list";

type PreferredSellAction = "selected-offer" | "add-product-to-sell-list" | "list-for-sale";

function preferredSellActionFromActionData(
  actionData: DiscoveryItemDetailActionData,
  actionErrorMessage: string | null,
): PreferredSellAction | null {
  if (!actionErrorMessage || !actionData || typeof actionData !== "object") {
    return null;
  }

  const intent = "intent" in actionData && typeof actionData.intent === "string" ? actionData.intent : null;
  switch (intent) {
    case "sell-now":
    case "add-to-sell-list":
      return "selected-offer";
    case "add-product-to-sell-list":
      return "add-product-to-sell-list";
    case "create-listing-stock-location":
    case "list-at-price":
      return "list-for-sale";
    default:
      return null;
  }
}

export function buildItemDetailCommerce(
  data: DiscoveryItemDetailRouteData,
  actionData: DiscoveryItemDetailActionData,
  actionErrorMessage: string | null,
): ((context: ItemDetailMarketplaceSectionContext) => ItemDetailCommerceSections | null) | undefined {
  if (!data.item) {
    return undefined;
  }

  const item = data.item;

  return (context) => {
    const selectedOwnedListing =
      data.sellerAccountId &&
      context.selectedListingSource === "explicit" &&
      context.selectedListing?.account_id === data.sellerAccountId
        ? context.selectedListing
        : null;
    const preferredSellAction =
      preferredSellActionFromActionData(actionData, actionErrorMessage) ??
      (selectedOwnedListing ? "list-for-sale" : null);
    const ownListing =
      data.sellerAccountId && context.selectedProductId
        ? (selectedOwnedListing ??
          context.visibleListings.find(
            (listing) =>
              listing.account_id === data.sellerAccountId && listing.product_id === context.selectedProductId,
          ) ??
          null)
        : null;
    const renderBuy = (
      formId: string,
      panelVariant: FormPanelVariant = "card",
      actions?: ReactNode,
      showSummary?: boolean,
      actionMode?: "all" | "buy-now" | "add-to-cart",
    ) => (
      <CheckoutPurchaseIntentSection
        formId={formId}
        panelVariant={panelVariant}
        showSummary={showSummary}
        actions={actions}
        actionMode={actionMode}
        catalogItemId={context.itemId}
        productId={context.selectedProductId}
        selectedListing={context.selectedListing}
        selectedListingSource={context.selectedListingSource}
        itemTitle={context.itemTitle}
        selectedOptions={context.selectedProductOptions}
        productSelectionDetails={context.selectedProductSelectionDetails}
        productSummary={context.selectedProductSummary}
        visibleListingCount={context.visibleListings.length}
        errorMessage={actionErrorMessage}
      />
    );
    const renderProductAlert = (
      formId: string,
      marketSide: "listing" | "offer",
      panelVariant: FormPanelVariant = "card",
      showSummary?: boolean,
    ) => (
      <ProductAlertCreationSection
        formId={formId}
        panelVariant={panelVariant}
        showSummary={showSummary}
        marketSide={marketSide}
        catalogItemId={context.itemId}
        productId={context.selectedProductId}
        selectedOptions={context.selectedProductOptions}
        productSelectionDetails={context.selectedProductSelectionDetails}
        productSummary={context.selectedProductSummary}
        errorMessage={data.productAlertClaimError ?? actionErrorMessage}
      />
    );
    const renderOffer = (
      formId: string,
      panelVariant: FormPanelVariant = "card",
      actions?: ReactNode,
      showSummary?: boolean,
    ) => (
      <MarketplaceOfferSubmissionSection
        formId={formId}
        panelVariant={panelVariant}
        showSummary={showSummary}
        actions={actions}
        catalogItemId={context.itemId}
        productId={context.selectedProductId}
        itemTitle={context.itemTitle}
        selectedOptions={context.selectedProductOptions}
        productSelectionDetails={context.selectedProductSelectionDetails}
        productSummary={context.selectedProductSummary}
        lowestListing={context.bestListing}
        errorMessage={actionErrorMessage}
      />
    );
    const renderOfferMatch = (
      formId: string,
      panelVariant: FormPanelVariant = "card",
      actions?: ReactNode,
      showSummary?: boolean,
      actionMode?: "all" | "sell-now" | "add-to-sell-list",
    ) => {
      const selectedOfferForSellRail = data.canUseSellerFeatures
        ? (context.selectedAccountOfferMatch ??
          (context.selectedOffer
            ? {
                ...context.selectedOffer,
                acceptance_terms: context.selectedOffer.public_standard_terms_preview ?? null,
              }
            : null))
        : context.selectedOffer
          ? {
              ...context.selectedOffer,
              acceptance_terms: context.selectedOffer.public_standard_terms_preview ?? null,
            }
          : null;
      const matchingOfferCountForSellRail = data.canUseSellerFeatures
        ? context.visibleAccountOfferMatches.length
        : context.visibleOffers.length;

      return (
        <MarketplaceOfferMatchSection
          formId={formId}
          panelVariant={panelVariant}
          showSummary={showSummary}
          actions={actions}
          actionMode={actionMode}
          sellNowIntent={data.canUseSellerFeatures ? "sell-now" : "add-to-sell-list"}
          selectedOffer={selectedOfferForSellRail}
          selectedOfferSource={context.selectedOfferSource}
          productId={context.selectedProductId}
          productSelectionDetails={context.selectedProductSelectionDetails}
          productSummary={context.selectedProductSummary}
          matchingOfferCount={matchingOfferCountForSellRail}
          errorMessage={actionErrorMessage}
        />
      );
    };
    const renderListingSubmission = (
      formId: string,
      panelVariant: FormPanelVariant = "card",
      actions?: ReactNode,
      showSummary?: boolean,
    ) => (
      <MarketplaceListingSubmissionSection
        formId={formId}
        panelVariant={panelVariant}
        showSummary={showSummary}
        actions={actions}
        productId={context.selectedProductId}
        selectedOptions={context.selectedProductOptions}
        productSummary={context.selectedProductSummary}
        productSelectionDetails={context.selectedProductSelectionDetails}
        bestListing={context.bestListing}
        ownListing={ownListing}
        hasListingStockLocation={data.hasListingStockLocation}
        listingSetupLoadState={data.listingSetupLoadState}
        allowDraftWithoutShipFromSetup={data.canUseGuestListingDraft}
        errorMessage={data.listingSetupLoadError ?? actionErrorMessage}
      />
    );
    const renderSellerRegistration = (
      panelVariant: FormPanelVariant = "card",
      showSummary?: boolean,
      mode?: "combined" | "offer" | "listing",
    ) => (
      <MarketplaceSellerRegistrationSection
        panelVariant={panelVariant}
        showSummary={showSummary}
        mode={mode}
        productSummary={context.selectedProductSummary}
        productSelectionDetails={context.selectedProductSelectionDetails}
        selectedOffer={context.selectedOffer}
        selectedOfferSource={context.selectedOfferSource}
        matchingOfferCount={context.visibleOffers.length}
        registerHref={data.registerToSellHref}
      />
    );
    const renderBuyActionCard = (
      formIdPrefix: string,
      panelVariant: FormPanelVariant = "card",
      accordionEdge?: CommerceAccordionEdge,
    ) => (
      <BuyActionCard
        formIdPrefix={formIdPrefix}
        panelVariant={panelVariant}
        accordionEdge={accordionEdge}
        productId={context.selectedProductId}
        productSummary={context.selectedProductSummary}
        productSelectionDetails={context.selectedProductSelectionDetails}
        visibleListingCount={context.visibleListings.length}
        hasSelectedListing={Boolean(context.selectedListing)}
        selectedListingSource={context.selectedListingSource}
        renderBuyNow={(formId) => renderBuy(formId, "plain", undefined, true, "buy-now")}
        renderAddToCart={(formId) => renderBuy(formId, "plain", undefined, true, "add-to-cart")}
        renderOffer={(formId) => renderOffer(formId, "plain", undefined, true)}
      />
    );
    const renderSellActionCard = (
      formIdPrefix: string,
      panelVariant: FormPanelVariant = "card",
      accordionEdge?: CommerceAccordionEdge,
    ) => (
      <SellActionCard
        formIdPrefix={formIdPrefix}
        panelVariant={panelVariant}
        accordionEdge={accordionEdge}
        productId={context.selectedProductId}
        productSummary={context.selectedProductSummary}
        productSelectionDetails={context.selectedProductSelectionDetails}
        hasMatchingOffer={
          data.canUseSellerFeatures
            ? Boolean(context.selectedAccountOfferMatch ?? context.selectedOffer)
            : Boolean(context.selectedOffer)
        }
        canSelectListingAction={Boolean(context.selectedProductId)}
        canSelectProductSellListAction={Boolean(context.selectedProductId)}
        selectedOfferSource={context.selectedOfferSource}
        preferredAction={preferredSellAction}
        renderSelectedOffer={(formId) => renderOfferMatch(formId, "plain", undefined, true)}
        renderAddProductToSellList={(formId) =>
          context.selectedProductId ? (
            <ProductSellListIntentSection
              formId={formId}
              panelVariant="plain"
              showSummary
              catalogItemId={item.catalog_item_id}
              productId={context.selectedProductId}
              itemTitle={item.title}
              selectedOptions={context.selectedProductOptions}
              productSelectionDetails={context.selectedProductSelectionDetails}
              productSummary={context.selectedProductSummary}
              errorMessage={actionData?.error ?? null}
            />
          ) : (
            renderSellerRegistration("plain", true, "offer")
          )
        }
        renderListing={(formId) =>
          data.canUseListingFeatures || data.canUseGuestListingDraft
            ? renderListingSubmission(formId, "plain", undefined, true)
            : renderSellerRegistration("plain", true, "listing")
        }
      />
    );
    const renderWatchActionCard = (
      formIdPrefix: string,
      panelVariant: FormPanelVariant = "card",
      accordionEdge?: CommerceAccordionEdge,
    ) => (
      <WatchActionCard
        formIdPrefix={formIdPrefix}
        panelVariant={panelVariant}
        accordionEdge={accordionEdge}
        productId={context.selectedProductId}
        productSummary={context.selectedProductSummary}
        productSelectionDetails={context.selectedProductSelectionDetails}
        renderListingAlert={(formId) => renderProductAlert(formId, "listing", "plain", true)}
        renderOfferAlert={(formId) => renderProductAlert(formId, "offer", "plain", true)}
      />
    );
    return {
      save: context.selectedProductId ? (
        <AddToSavedListControl
          productKey={context.selectedProductId}
          productLabel={[context.itemTitle, context.selectedProductSummary].filter(Boolean).join(" · ")}
          prepareFields={{
            productId: context.selectedProductId,
            selectedOptions: JSON.stringify(context.selectedProductOptions),
            productLabel: [context.itemTitle, context.selectedProductSummary].filter(Boolean).join(" · "),
          }}
          initialPreparation={
            data.savedListClaim?.preparation?.product.productId === context.selectedProductId
              ? data.savedListClaim.preparation
              : null
          }
          initialError={data.savedListClaim?.error ?? null}
          tone="secondary"
          size="md"
        />
      ) : undefined,
      buy: renderBuyActionCard("buy-card", "plain"),
      offer: null,
      sell: data.showSellerTab ? renderSellActionCard("sell-card", "plain") : undefined,
      watch: renderWatchActionCard("watch-card", "plain"),
      mobile: {
        buy: {
          content: renderBuyActionCard("mobile-buy-card", "plain", "panel"),
        },
        sell: {
          content: renderSellActionCard("mobile-sell-card", "plain", "panel"),
        },
        watch: {
          content: renderWatchActionCard("mobile-watch-card", "plain", "panel"),
        },
      },
      sellLabel: data.canUseSellerFeatures
        ? t("discovery.routes.itemDetail.sell.2")
        : t("discovery.routes.itemDetail.sell.3"),
      watchLabel: t("discovery.routes.itemDetail.watch"),
    };
  };
}
