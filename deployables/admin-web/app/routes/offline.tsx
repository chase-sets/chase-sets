import { t } from "@chase-sets/localization";
import { Button, ChaseRoot, EmptyState, Page } from "@chase-sets/design-system";

export function meta() {
  return [{ title: t("adminWeb.app.routes.offline.title") }];
}

export default function AdminOfflineRoute() {
  return (
    <ChaseRoot colorMode="system">
      <main>
        <Page width="narrow">
          <EmptyState
            icon="clock"
            title={t("adminWeb.app.routes.offline.heading")}
            description={t("adminWeb.app.routes.offline.description")}
            actions={
              <Button type="button" tone="primary" onClick={() => window.location.reload()}>
                {t("adminWeb.app.routes.offline.retry")}
              </Button>
            }
          />
        </Page>
      </main>
    </ChaseRoot>
  );
}
