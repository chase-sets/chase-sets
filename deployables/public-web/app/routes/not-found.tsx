import { t } from "@chase-sets/localization";
import { LinkButton, MarketplaceEmptyState, Page, PlatformCredibilityCue } from "@chase-sets/design-system";

export function meta() {
  return [{ title: [t("marketplace.app.root.page.not.found"), "Chase Sets"].join(" | ") }];
}

export function loader() {
  return new Response(null, { status: 404 });
}

export default function PublicNotFoundRoute() {
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
        recoveryActions={<LinkButton href="/">{t("marketplace.app.root.go.home")}</LinkButton>}
      />
    </Page>
  );
}
