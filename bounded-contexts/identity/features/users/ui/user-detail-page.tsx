import { t } from "@chase-sets/localization";
import { HiddenInput, Form, Button, Inline, Stack, TextInput } from "@chase-sets/design-system";
import { AdminDetailPage } from "../../../support/shell-support/ui/admin-pages";
import type { User } from "./contracts";

export function UserDetailPage({ data }: { data: User }) {
  return (
    <AdminDetailPage
      breadcrumbs={[
        { label: t("identity.features.users.ui.userListPage.users"), href: "/access/users" },
        { label: data.display_name },
      ]}
      title={data.display_name}
      status={data.status}
      actions={
        <Inline gap={2}>
          <Form spacing="none" method="post">
            <Stack direction="row" align="end" gap={2}>
              <HiddenInput type="hidden" name="intent" value="update-profile" readOnly />
              <TextInput
                name="displayName"
                label={t("identity.features.users.ui.userDetailPage.display.name")}
                defaultValue={data.display_name}
                required
              />
              <TextInput
                name="givenName"
                label={t("identity.features.users.ui.userDetailPage.given.name")}
                defaultValue={data.given_name}
              />
              <TextInput
                name="familyName"
                label={t("identity.features.users.ui.userDetailPage.family.name")}
                defaultValue={data.family_name}
              />
              <Button type="submit" tone="secondary">
                {t("identity.features.users.ui.userDetailPage.update.profile")}
              </Button>
            </Stack>
          </Form>
          {data.status === "active" ? (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="suspend" readOnly />
              <Button type="submit" tone="danger">
                {t("identity.features.users.ui.userDetailPage.suspend")}
              </Button>
            </Form>
          ) : (
            <Form spacing="none" method="post">
              <HiddenInput type="hidden" name="intent" value="reactivate" readOnly />
              <Button type="submit" tone="primary">
                {t("identity.features.users.ui.userDetailPage.reactivate")}
              </Button>
            </Form>
          )}
        </Inline>
      }
      sections={[
        { label: t("identity.features.users.ui.userDetailPage.user.id"), value: data.user_id },
        {
          label: t("identity.features.users.ui.userDetailPage.email"),
          value: data.primary_email ?? t("identity.features.users.ui.userDetailPage.none"),
        },
        {
          label: t("identity.features.users.ui.userDetailPage.given.name"),
          value: data.given_name || t("identity.features.users.ui.userDetailPage.none"),
        },
        {
          label: t("identity.features.users.ui.userDetailPage.family.name"),
          value: data.family_name || t("identity.features.users.ui.userDetailPage.none.2"),
        },
        {
          label: t("identity.features.users.ui.userDetailPage.auth.methods"),
          value: data.auth_methods.join(", ") || t("identity.features.users.ui.userDetailPage.none.3"),
        },
        { label: t("identity.features.users.ui.userDetailPage.updated.at"), value: data.updated_at },
      ]}
    />
  );
}
