import { t } from "@chase-sets/localization";
import {
  MarketplaceDashboardPanel,
  PlatformCredibilityCue,
  UiPage,
  UiPageHeader,
  UiPageSection,
  UiSurface,
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
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <UiSurface>
            <dl className="grid gap-3">
              {[
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
              ].map((item) => (
                <div key={item.label} className="grid gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] p-3">
                  <dt className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">{item.label}</dt>
                  <dd className="m-0 text-sm font-semibold text-[var(--foreground)]">{item.value}</dd>
                </div>
              ))}
            </dl>
          </UiSurface>
          <PlatformCredibilityCue
            title={t("identity.features.accounts.ui.accountProfilePage.platform.protection.active")}
            description={t("identity.features.accounts.ui.accountProfilePage.platform.protection.active.description")}
          />
        </div>
      </UiPageSection>
    </UiPage>
  );
}
