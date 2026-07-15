import { Page, PageHeader } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";

export function SellerDeskIndexPage() {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.sellerDesk.ui.index.eyebrow")}
        title={t("marketplace.features.sellerDesk.ui.index.title")}
        description={t("marketplace.features.sellerDesk.ui.index.description")}
      />
    </Page>
  );
}
