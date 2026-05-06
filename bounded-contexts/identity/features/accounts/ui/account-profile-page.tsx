import { t } from "@chase-sets/localization";
import {
  MarketplaceDashboardPanel,
  PlatformCredibilityCue,
  SpecificationList,
  Stack,
  UiPage,
  UiPageHeader,
  UiPageSection,
} from "@chase-sets/design-system";
import type { Account } from "./contracts";

function formatAccountValue(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AccountProfilePage({ account }: { account: Account }) {
  const updatedAt = account.updated_at
    ? new Date(account.updated_at).toLocaleDateString()
    : t("identity.features.accounts.ui.accountProfilePage.not.available");

  return (
    <UiPage>
      <UiPageHeader
        eyebrow={t("identity.features.accounts.ui.accountProfilePage.account")}
        title={account.display_name}
        description={t("identity.features.accounts.ui.accountProfilePage.profile.and.commercial.ownership.details.for")}
      />
      <MarketplaceDashboardPanel
        title={t("identity.features.accounts.ui.accountProfilePage.marketplace.readiness")}
        description={t("identity.features.accounts.ui.accountProfilePage.marketplace.readiness.description")}
        metrics={[
          {
            label: t("identity.features.accounts.ui.accountProfilePage.account.type"),
            value: formatAccountValue(account.account_type),
            detail: t("identity.features.accounts.ui.accountProfilePage.commercial.identity"),
          },
          {
            label: t("identity.features.accounts.ui.accountProfilePage.status"),
            value: formatAccountValue(account.status),
            detail: t("identity.features.accounts.ui.accountProfilePage.active.accounts.can.buy.sell.and.receive"),
          },
          {
            label: t("identity.features.accounts.ui.accountProfilePage.updated"),
            value: updatedAt,
            detail: t("identity.features.accounts.ui.accountProfilePage.profile.changes.are.visible"),
          },
        ]}
      />
      <UiPageSection
        title={t("identity.features.accounts.ui.accountProfilePage.trust.details")}
        description={t("identity.features.accounts.ui.accountProfilePage.trust.details.description")}
      >
        <Stack>
          <SpecificationList
            specs={[
              {
                label: t("identity.features.accounts.ui.accountProfilePage.legal.name"),
                value: account.name,
              },
              {
                label: t("identity.features.accounts.ui.accountProfilePage.marketplace.name"),
                value: account.display_name,
              },
              {
                label: t("identity.features.accounts.ui.accountProfilePage.status"),
                value: formatAccountValue(account.status),
              },
            ]}
          />
          <PlatformCredibilityCue
            title={t("identity.features.accounts.ui.accountProfilePage.platform.protection.active")}
            description={t("identity.features.accounts.ui.accountProfilePage.platform.protection.active.description")}
          />
        </Stack>
      </UiPageSection>
    </UiPage>
  );
}
