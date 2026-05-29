import { LinkButton, MarketplaceEmptyState, Page, PlatformCredibilityCue } from "@chase-sets/design-system";
import { publicPresenceT as t } from "@chase-sets/public-presence/web";

export function meta() {
  return [{ title: [t("publicPresence.appRoot.pageNotFound"), "Chase Sets"].join(" | ") }];
}

export function loader() {
  return new Response(null, { status: 404 });
}

export default function PublicNotFoundRoute() {
  return (
    <Page width="narrow">
      <MarketplaceEmptyState
        title={t("publicPresence.appRoot.pageNotFound")}
        description={t("publicPresence.appRoot.pageNotFound.description")}
        trustCue={
          <PlatformCredibilityCue
            title={t("publicPresence.appRoot.publicError")}
            description={t("publicPresence.appRoot.error.trustCue")}
          />
        }
        recoveryActions={<LinkButton href="/">{t("publicPresence.appRoot.goHome")}</LinkButton>}
      />
    </Page>
  );
}
