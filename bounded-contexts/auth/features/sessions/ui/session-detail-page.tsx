import { authenticationMethodLabel, formatDateTime, t } from "@chase-sets/localization";
import {
  AdminResourceDetailPage,
  HiddenInput,
  Form,
  Button,
  Inline,
  ModalDialog,
  NativeSelect,
  Stack,
} from "@chase-sets/design-system";
import type { Session } from "./contracts";
import { authDateUnavailable, sessionStatusLabel } from "../../../support/ui-support/value-labels";

export function SessionDetailPage({ data }: { data: Session }) {
  const user = data.user_display_name ?? data.user_primary_email ?? data.user_id;
  const account = data.account_display_name ?? data.account_name ?? data.account_id;

  return (
    <AdminResourceDetailPage
      breadcrumbs={[
        { label: t("auth.features.sessions.ui.sessionListPage.sessions"), href: "/access/sessions" },
        { label: user },
      ]}
      title={t("auth.features.sessions.ui.sessionDetailPage.title", { user })}
      status={sessionStatusLabel(data.status)}
      actions={
        <Inline gap={2}>
          {data.status === "active" ? (
            <>
              <Form spacing="none" method="post">
                <Stack direction="row" align="end" gap={2}>
                  <HiddenInput type="hidden" name="intent" value="switch-account" readOnly />
                  <NativeSelect
                    name="accountId"
                    label={t("auth.features.sessions.ui.sessionDetailPage.active.account")}
                    defaultValue={data.account_id}
                    items={data.available_account_ids.map((accountId) => ({
                      value: accountId,
                      label: accountId === data.account_id ? account : accountId,
                    }))}
                  />
                  <Button type="submit" tone="secondary">
                    {t("auth.features.sessions.ui.sessionDetailPage.switch.account")}
                  </Button>
                </Stack>
              </Form>
              <ModalDialog
                title={t("auth.features.sessions.ui.sessionDetailPage.revoke.confirm.title", { user })}
                description={t("auth.features.sessions.ui.sessionDetailPage.revoke.confirm.description", {
                  user,
                  account,
                })}
                trigger={
                  <Button type="button" tone="danger">
                    {t("auth.features.sessions.ui.sessionDetailPage.revoke")}
                  </Button>
                }
              >
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="revoke" readOnly />
                  <Button type="submit" tone="danger">
                    {t("auth.features.sessions.ui.sessionDetailPage.revoke.confirm.action")}
                  </Button>
                </Form>
              </ModalDialog>
            </>
          ) : null}
        </Inline>
      }
      sections={[
        { label: t("auth.features.sessions.ui.sessionDetailPage.session.id"), value: data.session_id },
        { label: t("auth.features.sessions.ui.sessionDetailPage.user"), value: user },
        { label: t("auth.features.sessions.ui.sessionDetailPage.active.account"), value: account },
        {
          label: t("auth.features.sessions.ui.sessionDetailPage.available.accounts"),
          value: data.available_account_ids.join(", "),
        },
        {
          label: t("auth.features.sessions.ui.sessionDetailPage.authentication.method"),
          value: authenticationMethodLabel(data.authentication_method, t),
        },
        {
          label: t("auth.features.sessions.ui.sessionDetailPage.expires.at"),
          value: formatDateTime(data.expires_at, { fallback: authDateUnavailable() }),
        },
      ]}
    />
  );
}
