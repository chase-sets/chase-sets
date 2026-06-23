import { t } from "@chase-sets/localization";
import { isRouteErrorResponse, useLocation, useRouteError } from "react-router";
import { classifyPostWriteRouteRecovery } from "@chase-sets/http/responses";
import { LinkButton, MarketplaceEmptyState, Page, PageHeader, PageSection } from "@chase-sets/design-system";

type OfferDetailRecoveryKind = "submitted-offer" | "offer-match";

type OfferDetailRecoveryCopy = Readonly<{
  eyebrow: string;
  preparingTitle: string;
  preparingDescription: string;
  listPath: string;
  listLabel: string;
}>;

function recoveryCopy(kind: OfferDetailRecoveryKind): OfferDetailRecoveryCopy {
  switch (kind) {
    case "offer-match":
      return {
        eyebrow: t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match"),
        preparingTitle: t("marketplace.routes.accountOfferMatch.offer.match.preparing"),
        preparingDescription: t("marketplace.routes.accountOfferMatch.offer.match.preparing.description"),
        listPath: "/account/offers/matches",
        listLabel: t("marketplace.features.offers.ui.offerMatchDetailPage.back.to.offer.matches"),
      };
    case "submitted-offer":
      return {
        eyebrow: t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview"),
        preparingTitle: t("marketplace.routes.accountOfferSubmitted.submitted.offer.preparing"),
        preparingDescription: t("marketplace.routes.accountOfferSubmitted.submitted.offer.preparing.description"),
        listPath: "/account/offers/submitted",
        listLabel: t("marketplace.features.offers.ui.submittedOfferDetailPage.back.to.submitted.offers"),
      };
  }
}

export function MarketplaceOfferDetailRecoveryPage({
  kind,
  currentPath,
}: Readonly<{ kind: OfferDetailRecoveryKind; currentPath: string }>) {
  const copy = recoveryCopy(kind);

  return (
    <Page>
      <PageHeader eyebrow={copy.eyebrow} title={copy.preparingTitle} description={copy.preparingDescription} />
      <PageSection title={t("marketplace.features.offers.ui.offerDetailRecoveryPage.recover.offer")}>
        <MarketplaceEmptyState
          title={copy.preparingTitle}
          description={copy.preparingDescription}
          trustCue={t("marketplace.features.offers.ui.offerDetailRecoveryPage.no.payment.or.sale.changed")}
          recoveryActions={
            <>
              <LinkButton href={currentPath} leadingIcon="refreshCcw">
                {t("marketplace.features.offers.ui.offerDetailRecoveryPage.refresh.offer")}
              </LinkButton>
              <LinkButton href={copy.listPath} tone="secondary">
                {copy.listLabel}
              </LinkButton>
            </>
          }
        />
      </PageSection>
    </Page>
  );
}

export function MarketplaceOfferDetailErrorBoundary({ kind }: Readonly<{ kind: OfferDetailRecoveryKind }>) {
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

  return <MarketplaceOfferDetailRecoveryPage kind={kind} currentPath={currentPath} />;
}

export function SubmittedOfferDetailErrorBoundary() {
  return <MarketplaceOfferDetailErrorBoundary kind="submitted-offer" />;
}

export function OfferMatchDetailErrorBoundary() {
  return <MarketplaceOfferDetailErrorBoundary kind="offer-match" />;
}
