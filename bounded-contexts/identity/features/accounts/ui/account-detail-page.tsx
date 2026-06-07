import { t } from "@chase-sets/localization";
import { Form, Button, Inline, Stack, TextInput } from "@chase-sets/design-system";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import { AccountBadgeList, accountBadgeLabel } from "./account-badges";
import type { Account } from "./contracts";

export function AccountDetailPage({ data }: { data: Account }) {
  const hasFoundingBadge = data.badges.includes("founding-account");
  return (
    <AdminDetailPage
      title={
        <Inline gap={2}>
          <span>{data.display_name}</span>
          <AccountBadgeList badges={data.badges} />
        </Inline>
      }
      status={data.status}
      actions={
        <Inline gap={2}>
          <Form spacing="none" method="post">
            <Stack direction="row" align="end" gap={2}>
              <input type="hidden" name="intent" value="update-profile" readOnly />
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
          <Form spacing="none" method="post">
            <input
              type="hidden"
              name="intent"
              value={hasFoundingBadge ? "remove-founding-account-badge" : "assign-founding-account-badge"}
              readOnly
            />
            <Button type="submit" tone={hasFoundingBadge ? "secondary" : "primary"}>
              {hasFoundingBadge
                ? t("identity.features.accounts.ui.accountDetailPage.remove.founding.account.badge")
                : t("identity.features.accounts.ui.accountDetailPage.assign.founding.account.badge")}
            </Button>
          </Form>
          {data.status === "active" ? (
            <Form spacing="none" method="post">
              <input type="hidden" name="intent" value="suspend" readOnly />
              <Button type="submit" tone="danger">
                {t("identity.features.accounts.ui.accountDetailPage.suspend")}
              </Button>
            </Form>
          ) : null}
          {data.status === "suspended" ? (
            <Form spacing="none" method="post">
              <input type="hidden" name="intent" value="reactivate" readOnly />
              <Button type="submit" tone="primary">
                {t("identity.features.accounts.ui.accountDetailPage.reactivate")}
              </Button>
            </Form>
          ) : null}
          {data.status !== "closed" ? (
            <Form spacing="none" method="post">
              <input type="hidden" name="intent" value="close" readOnly />
              <Button type="submit" tone="danger">
                {t("identity.features.accounts.ui.accountDetailPage.close")}
              </Button>
            </Form>
          ) : null}
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
