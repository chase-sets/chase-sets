import { formatDate, t } from "@chase-sets/localization";
import { useId, useState } from "react";
import {
  HiddenInput,
  ActorIdentityCue,
  Button,
  Banner,
  InlineTextGroup,
  Inline,
  LinkButton,
  LinkText,
  MarketplaceDashboardPanel,
  Page,
  PageHeader,
  PageSection,
  PlatformCredibilityCue,
  SpecificationList,
  Stack,
  Text,
  TextInput,
  ValidationSummary,
} from "@chase-sets/design-system";
import type { Account } from "./contracts";
import type { CurrentActorDisplay } from "../../../support/shell-support/current-actor-display";
import { AccountBadgeList } from "./account-badges";
import { AccountMutationForm as Form, type MutationNotification } from "../../account-management/ui/controller";
import type { MutationFailure } from "../../account-management/ui/transport";
import type { DisplayNameRejectionCode } from "../domain/display-name-safeguard";
import {
  accountStatusLabel,
  accountTypeLabel,
  identityDateUnavailable,
  membershipRoleLabel,
} from "../../../support/ui-support/value-labels";

function displayActorAccountName(display: CurrentActorDisplay) {
  return display.account.display_name ?? display.account.name ?? display.account.account_id;
}

const displayNameRecovery = {
  text_control_character: "identity.features.accounts.ui.accountProfilePage.removeControlCharacters",
  text_direction_override: "identity.features.accounts.ui.accountProfilePage.removeDirectionOverrides",
  text_unsafe_link: "identity.features.accounts.ui.accountProfilePage.useHttps",
  text_duplicate_link: "identity.features.accounts.ui.accountProfilePage.removeDuplicateLinks",
} as const satisfies Record<DisplayNameRejectionCode, string>;

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
  errorMessage,
}: {
  account: Account;
  actorDisplay?: CurrentActorDisplay | null;
  errorMessage?: string;
}) {
  const fieldId = useId();
  const [failure, setFailure] = useState<MutationFailure | null>(null);
  const displayNameRejection = failure?.displayNameRejection;
  const displayNameLabel = t("identity.features.accounts.ui.accountProfilePage.marketplace.name");
  function onMutation(notification: MutationNotification) {
    setFailure(notification.type === "failure" ? notification.failure : null);
  }
  const updatedAt = account.updated_at
    ? formatDate(account.updated_at, { fallback: identityDateUnavailable() })
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
            <Form spacing="none" method="post" onMutation={onMutation}>
              {displayNameRejection ? (
                <ValidationSummary
                  title={t("identity.features.accounts.ui.accountProfilePage.displayNameRejected")}
                  description={t("identity.features.accounts.ui.accountProfilePage.draftKept")}
                  errors={[
                    { fieldId, fieldName: displayNameLabel, message: t(displayNameRecovery[displayNameRejection]) },
                  ]}
                />
              ) : failure ? (
                <Banner tone="danger" title={failure.message} />
              ) : null}
              <Stack direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "end" }} gap={2}>
                <HiddenInput type="hidden" name="intent" value="update-profile" readOnly />
                <TextInput
                  name="name"
                  label={t("identity.features.accounts.ui.accountProfilePage.legal.name")}
                  defaultValue={account.name}
                  required
                />
                <TextInput
                  id={fieldId}
                  name="displayName"
                  label={displayNameLabel}
                  defaultValue={account.display_name}
                  required
                />
                <Button type="submit" tone="secondary">
                  {t("identity.features.accounts.ui.accountProfilePage.update.profile")}
                </Button>
              </Stack>
              <Text size="sm" tone="secondary">
                {t("identity.features.accounts.ui.accountProfilePage.publicNameGuidance")}
              </Text>
              <Inline gap={3}>
                <LinkText href="/help/buying/community-guidelines-and-enforcement">
                  {t("identity.features.accounts.ui.accountProfilePage.communityGuidelines")}
                </LinkText>
                <LinkText href="/contact">
                  {t("identity.features.accounts.ui.accountProfilePage.contactSupport")}
                </LinkText>
              </Inline>
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
      {errorMessage ? <Banner tone="danger" title={errorMessage} /> : null}
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
          membershipName={membershipRoleLabel(actorDisplay.membership.role_key)}
          membershipDetail={t("identity.features.accounts.ui.currentActorDisplayCue.active.membership")}
        />
      ) : null}
      <MarketplaceDashboardPanel
        title={t("identity.features.accounts.ui.accountProfilePage.marketplace.readiness")}
        description={t("identity.features.accounts.ui.accountProfilePage.marketplace.readiness.description")}
        metrics={[
          {
            label: t("identity.features.accounts.ui.accountProfilePage.account.type"),
            value: accountTypeLabel(account.account_type),
            detail: t("identity.features.accounts.ui.accountProfilePage.commercial.identity"),
          },
          {
            label: t("identity.features.accounts.ui.accountProfilePage.status"),
            value: accountStatusLabel(account.status),
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
                value: accountStatusLabel(account.status),
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
