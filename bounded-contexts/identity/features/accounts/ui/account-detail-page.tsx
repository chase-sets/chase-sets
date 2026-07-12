import { t } from "@chase-sets/localization";
import {
  AdminResourceDetailPage,
  HiddenInput,
  Form,
  Button,
  Inline,
  NativeSelect,
  Stack,
  TextInput,
} from "@chase-sets/design-system";
import { grantableRoleSelectItems } from "../../memberships/ui/role-select-items";
import { AccountBadgeList, accountBadgeLabel, accountBadgeKeys, accountBadgeLabels } from "./account-badges";
import type { Account } from "./contracts";

export function AccountDetailPage({ data }: { data: Account }) {
  return (
    <AdminResourceDetailPage
      breadcrumbs={[
        { label: t("identity.features.accounts.ui.accountListPage.accounts"), href: "/access/accounts" },
        { label: data.display_name },
      ]}
      title={data.display_name}
      titleAside={<AccountBadgeList badges={data.badges} founderNumber={data.founder_number} />}
      status={data.status}
      actions={
        <Inline gap={2}>
          <Form spacing="none" method="post">
            <Stack direction="row" align="end" gap={2}>
              <HiddenInput type="hidden" name="intent" value="update-profile" readOnly />
              <TextInput
                name="name"
                label={t("identity.features.accounts.ui.accountDetailPage.legal.name")}
                defaultValue={data.name}
                required
              />
              <TextInput
                name="displayName"
                label={t("identity.features.accounts.ui.accountDetailPage.display.name")}
                defaultValue={data.display_name}
                required
              />
              <Button type="submit" tone="secondary">
                {t("identity.features.accounts.ui.accountDetailPage.update.profile")}
              </Button>
            </Stack>
          </Form>
          {accountBadgeKeys
            .filter((badgeKey) => badgeKey !== "founding-account")
            .map((badgeKey) => {
              const assigned = data.badges.includes(badgeKey);
              const badge = accountBadgeLabels[badgeKey];
              return (
                <Form key={badgeKey} spacing="none" method="post">
                  <HiddenInput
                    type="hidden"
                    name="intent"
                    value={assigned ? "remove-account-badge" : "assign-account-badge"}
                    readOnly
                  />
                  <HiddenInput type="hidden" name="badgeKey" value={badgeKey} readOnly />
                  <Button type="submit" tone={assigned ? "secondary" : "primary"}>
                    {assigned
                      ? t("identity.features.accounts.ui.accountDetailPage.remove.account.badge", { badge })
                      : t("identity.features.accounts.ui.accountDetailPage.assign.account.badge", { badge })}
                  </Button>
                </Form>
              );
            })}
          {data.status === "active" ? (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="suspend" readOnly />
              <Button type="submit" tone="danger">
                {t("identity.features.accounts.ui.accountDetailPage.suspend")}
              </Button>
            </Form>
          ) : null}
          {data.status === "suspended" ? (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="reactivate" readOnly />
              <Button type="submit" tone="primary">
                {t("identity.features.accounts.ui.accountDetailPage.reactivate")}
              </Button>
            </Form>
          ) : null}
          {data.status !== "closed" ? (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="close" readOnly />
              <Button type="submit" tone="danger">
                {t("identity.features.accounts.ui.accountDetailPage.close")}
              </Button>
            </Form>
          ) : null}
          <Form spacing="none" method="post">
            <Stack direction="row" align="end" gap={2}>
              <HiddenInput type="hidden" name="intent" value="create-invitation" readOnly />
              <HiddenInput type="hidden" name="accountId" value={data.account_id} readOnly />
              <TextInput
                name="email"
                label={t("identity.features.accounts.ui.accountDetailPage.invite.email")}
                type="email"
                required
              />
              <NativeSelect
                name="roleKey"
                label={t("identity.features.accounts.ui.accountDetailPage.invite.role")}
                defaultValue="viewer"
                items={grantableRoleSelectItems}
              />
              <Button type="submit" tone="primary">
                {t("identity.features.accounts.ui.accountDetailPage.invite.member")}
              </Button>
            </Stack>
          </Form>
        </Inline>
      }
      sections={[
        { label: t("identity.features.accounts.ui.accountDetailPage.account.id"), value: data.account_id },
        { label: t("identity.features.accounts.ui.accountDetailPage.legal.name"), value: data.name },
        { label: t("identity.features.accounts.ui.accountDetailPage.account.type"), value: data.account_type },
        {
          label: t("identity.features.accounts.ui.accountDetailPage.account.badges"),
          value:
            data.badges.length > 0
              ? data.badges.map(accountBadgeLabel).join(", ")
              : t("identity.features.accounts.ui.accountDetailPage.no.account.badges"),
        },
        { label: t("identity.features.accounts.ui.accountDetailPage.updated.at"), value: data.updated_at },
      ]}
    />
  );
}
