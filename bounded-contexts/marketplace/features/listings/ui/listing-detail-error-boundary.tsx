import { t } from "@chase-sets/localization";
import { isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import { classifyPostWriteRouteRecovery } from "@chase-sets/http/responses";
import { LinkButton, MarketplaceEmptyState, Page, PageHeader, PageSection } from "@chase-sets/design-system";

export function ListingDetailRecoveryPage({ currentPath }: Readonly<{ currentPath: string }>) {
  const preparingTitle = t("marketplace.routes.accountListing.listing.preparing");
  const preparingDescription = t("marketplace.routes.accountListing.listing.preparing.description");

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

export function ListingDetailErrorBoundary() {
  const error = useRouteError();
  const location = useLocation();
  const currentPath = `${location.pathname}${location.search}`;
  const recovery =
    isRouteErrorResponse(error) &&
    classifyPostWriteRouteRecovery({
      request: currentPath,
      status: error.status,
      body: error.data,
    });

  if (!recovery || recovery.kind !== "recover") {
    throw error;
  }

  return <ListingDetailRecoveryPage currentPath={currentPath} />;
}
