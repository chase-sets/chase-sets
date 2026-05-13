import { t } from "@chase-sets/localization";
import {
  ActorIdentityCue,
  LinkButton,
  MarketplaceDashboardPanel,
  PlatformCredibilityCue,
  SpecificationList,
  Stack,
  UiPage,
  UiPageHeader,
  UiPageSection,
} from "@chase-sets/design-system";
import type { Account } from "./contracts";
import type { CurrentActorDisplay } from "../../../support/request-support/current-actor-display";

function formatAccountValue(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayActorAccountName(display: CurrentActorDisplay) {
  return display.account.display_name ?? display.account.name ?? display.account.account_id;
}

function displayActorUserName(display: CurrentActorDisplay) {
  return display.user.display_name ?? display.user.primary_email ?? display.user.user_id;
}

export function AccountProfilePage({
  account,
  actorDisplay,
}: {
  account: Account;
  actorDisplay?: CurrentActorDisplay | null;
}) {
  const updatedAt = account.updated_at
    ? new Date(account.updated_at).toLocaleDateString()
    : t("identity.features.accounts.ui.accountProfilePage.not.available");

  return (
    <UiPage>
      <UiPageHeader
        eyebrow={t("identity.features.accounts.ui.accountProfilePage.account")}
        title={account.display_name}
        description={t("identity.features.accounts.ui.accountProfilePage.profile.and.commercial.ownership.details.for")}
        actions={
          <LinkButton href="/account/shipping-addresses" tone="secondary">
            {t("identity.features.accounts.ui.accountProfilePage.manage.shipping.addresses")}
          </LinkButton>
        }
      />
      {actorDisplay ? (
        <ActorIdentityCue
          variant="panel"
          title={t("identity.features.accounts.ui.currentActorDisplayCue.signed.in.identity")}
          description={t("identity.features.accounts.ui.currentActorDisplayCue.signed.in.identity.description")}
          accountLabel={t("identity.features.accounts.ui.currentActorDisplayCue.account")}
          accountName={displayActorAccountName(actorDisplay)}
          accountDetail={t("identity.features.accounts.ui.currentActorDisplayCue.selected.account")}
          userLabel={t("identity.features.accounts.ui.currentActorDisplayCue.user")}
          userName={displayActorUserName(actorDisplay)}
          userDetail={actorDisplay.user.primary_email ?? t("identity.features.accounts.ui.currentActorDisplayCue.current.user")}
          membershipLabel={t("identity.features.accounts.ui.currentActorDisplayCue.membership")}
          membershipName={formatAccountValue(actorDisplay.membership.role_key)}
          membershipDetail={t("identity.features.accounts.ui.currentActorDisplayCue.active.membership")}
        />
      ) : null}
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
