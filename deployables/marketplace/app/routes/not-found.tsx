import { t } from "@chase-sets/localization";
import { LinkButton, MarketplaceEmptyState, Page, PlatformCredibilityCue } from "@chase-sets/design-system";

export function meta() {
  return [{ title: [t("marketplace.app.root.page.not.found"), "Chase Sets"].join(" | ") }];
}

export default function MarketplaceNotFoundRoute() {
  return (
    <Page width="narrow">
      <MarketplaceEmptyState
        title={t("marketplace.app.root.page.not.found")}
        description={t("marketplace.app.root.page.not.found.description")}
        trustCue={
          <PlatformCredibilityCue
            title={t("marketplace.app.root.marketplace.error")}
            description={t("marketplace.app.root.error.trust.cue")}
          />
        }
        recoveryActions={
          <>
            <LinkButton href="/search">{t("marketplace.app.root.browse.marketplace")}</LinkButton>
            <LinkButton href="/" tone="secondary">
              {t("marketplace.app.root.go.home")}
            </LinkButton>
          </>
        }
      />
    </Page>
  );
}
