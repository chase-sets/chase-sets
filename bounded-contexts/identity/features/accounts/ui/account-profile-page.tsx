import { formatDate, t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  ActorIdentityCue,
  Button,
  InlineTextGroup,
  LinkButton,
  MarketplaceDashboardPanel,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  SpecificationList,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { Account } from "./contracts";
import type { CurrentActorDisplay } from "../../../support/shell-support/current-actor-display";
import { AccountBadgeList } from "./account-badges";

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

function AccountNameWithBadges({
  badges,
  name,
  founderNumber,
}: {
  badges: readonly string[];
  name: string;
  founderNumber: number | null;
}) {
  return (
    <InlineTextGroup>
      <Text element="span">{name}</Text>
      <AccountBadgeList badges={badges} founderNumber={founderNumber} />
    </InlineTextGroup>
  );
}

export function AccountProfilePage({
  account,
  actorDisplay,
}: {
  account: Account;
  actorDisplay?: CurrentActorDisplay | null;
}) {
  const updatedAt = account.updated_at
    ? formatDate(account.updated_at)
    : t("identity.features.accounts.ui.accountProfilePage.not.available");

  return (
    <Page>
      <PageHeader
        eyebrow={t("identity.features.accounts.ui.accountProfilePage.account")}
        title={
          <AccountNameWithBadges
            name={account.display_name}
            badges={account.badges}
            founderNumber={account.founder_number ?? null}
          />
        }
        description={t("identity.features.accounts.ui.accountProfilePage.profile.and.commercial.ownership.details.for")}
        actions={
          <Stack direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "end" }} gap={2}>
            <Form spacing="none" method="post">
              <Stack direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "end" }} gap={2}>
                <HiddenInput type="hidden" name="intent" value="update-profile" readOnly />
                <TextInput
                  name="name"
                  label={t("identity.features.accounts.ui.accountProfilePage.legal.name")}
                  defaultValue={account.name}
                  required
                />
                <TextInput
                  name="displayName"
                  label={t("identity.features.accounts.ui.accountProfilePage.marketplace.name")}
                  defaultValue={account.display_name}
                  required
                />
                <Button type="submit" tone="secondary">
                  {t("identity.features.accounts.ui.accountProfilePage.update.profile")}
                </Button>
              </Stack>
            </Form>
            <LinkButton href="/account/shipping-addresses" tone="secondary">
              {t("identity.features.accounts.ui.accountProfilePage.manage.shipping.addresses")}
            </LinkButton>
            <LinkButton href="/account/inventory/locations" tone="secondary">
              {t("identity.features.accounts.ui.accountProfilePage.manage.ship.from.locations")}
            </LinkButton>
            <LinkButton href="/account/listings" tone="secondary">
              {t("identity.features.accounts.ui.accountProfilePage.manage.time.away.and.order.capacity")}
            </LinkButton>
          </Stack>
        }
      />
      {actorDisplay ? (
        <ActorIdentityCue
          variant="panel"
          title={t("identity.features.accounts.ui.currentActorDisplayCue.signed.in.identity")}
          description={t("identity.features.accounts.ui.currentActorDisplayCue.signed.in.identity.description")}
          accountLabel={t("identity.features.accounts.ui.currentActorDisplayCue.account")}
          accountName={
            <AccountNameWithBadges
              name={displayActorAccountName(actorDisplay)}
              badges={actorDisplay.account.badges}
              founderNumber={null}
            />
          }
          accountDetail={t("identity.features.accounts.ui.currentActorDisplayCue.selected.account")}
          userLabel={t("identity.features.accounts.ui.currentActorDisplayCue.user")}
          userName={displayActorUserName(actorDisplay)}
          userDetail={
            actorDisplay.user.primary_email ?? t("identity.features.accounts.ui.currentActorDisplayCue.current.user")
          }
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
      <PageSection
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
      </PageSection>
    </Page>
  );
}
