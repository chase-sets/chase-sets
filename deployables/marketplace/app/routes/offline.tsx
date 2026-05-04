import { t } from "@chase-sets/localization";
import { Button, ChaseRoot, EmptyState, Page } from "@chase-sets/design-system";

export function meta() {
  return [{ title: t("marketplace.app.routes.offline.title") }];
}

export default function MarketplaceOfflineRoute() {
  return (
    <ChaseRoot colorMode="system">
      <main>
        <Page width="narrow">
          <EmptyState
            icon="warning"
            title={t("marketplace.app.routes.offline.heading")}
            description={t("marketplace.app.routes.offline.description")}
            actions={
              <Button
                type="button"
                tone="primary"
                onClick={() => window.location.reload()}
              >
                {t("marketplace.app.routes.offline.retry")}
              </Button>
            }
          />
        </Page>
      </main>
    </ChaseRoot>
  );
}
