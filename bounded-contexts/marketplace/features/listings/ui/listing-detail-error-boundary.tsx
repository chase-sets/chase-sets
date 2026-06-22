import { t } from "@chase-sets/localization";
import { isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import { LinkButton, MarketplaceEmptyState, Page, PageHeader, PageSection } from "@chase-sets/design-system";

export function ListingDetailErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  const preparingTitle = t("marketplace.routes.accountListing.listing.preparing");
  const preparingDescription = t("marketplace.routes.accountListing.listing.preparing.description");
  const searchParams = new URLSearchParams(location.search);
  const isFreshListingWrite =
    searchParams.has("afterWrite") &&
    ["listing-publish", "listing-update"].includes(searchParams.get("feedbackWorkflow") ?? "");
  const isPreparingListingResponse =
    isRouteErrorResponse(error) &&
    error.status === 503 &&
    (error.statusText === preparingTitle || error.data === preparingDescription || isFreshListingWrite);

  if (!isPreparingListingResponse) {
    throw error;
  }

  const currentPath = `${location.pathname}${location.search}`;

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listings.ui.listingDetailPage.seller")}
        title={preparingTitle}
        description={preparingDescription}
      />
      <PageSection title={t("marketplace.features.listings.ui.listingDetailRecoveryPage.recover.listing")}>
        <MarketplaceEmptyState
          title={preparingTitle}
          description={preparingDescription}
          trustCue={t("marketplace.features.listings.ui.listingDetailRecoveryPage.listing.action.saved")}
          recoveryActions={
            <>
              <LinkButton href={currentPath} leadingIcon="refreshCcw">
                {t("marketplace.features.listings.ui.listingDetailRecoveryPage.refresh.listing")}
              </LinkButton>
              <LinkButton href="/account/listings" tone="secondary">
                {t("marketplace.features.listings.ui.listingDetailPage.back.to.listings")}
              </LinkButton>
            </>
          }
        />
      </PageSection>
    </Page>
  );
}
