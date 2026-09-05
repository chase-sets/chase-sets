import { formatDateTime, t } from "@chase-sets/localization";
import {
  AdminResourceDetailPage,
  HiddenInput,
  Form,
  Button,
  Inline,
  ModalDialog,
  NativeSelect,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { User } from "./contracts";
import type { OneTimeApiKeySecret } from "../../api-keys/ui/contracts";
import { ApiKeySecretReveal } from "../../api-keys/ui/api-key-secret-reveal";
import {
  contactMethodTypeLabel,
  contactMethodTypeSelectItems,
  identityAuthenticationMethodLabel,
  identityAuthenticationMethodSelectItems,
  identityDateUnavailable,
  userStatusLabel,
} from "../../../support/ui-support/value-labels";

export function UserDetailPage({ data, oneTimeSecret }: { data: User; oneTimeSecret?: OneTimeApiKeySecret | null }) {
  return (
    <AdminResourceDetailPage
      breadcrumbs={[
        { label: t("identity.features.users.ui.userListPage.users"), href: "/access/users" },
        { label: data.display_name },
      ]}
      title={data.display_name}
      status={userStatusLabel(data.status)}
      actions={
        <Stack gap={3}>
          <ApiKeySecretReveal secret={oneTimeSecret} />
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
              <ModalDialog
                title={t("identity.features.users.ui.userDetailPage.suspend.confirm.title", {
                  user: data.display_name,
                })}
                description={t("identity.features.users.ui.userDetailPage.suspend.confirm.description", {
                  user: data.display_name,
                })}
                trigger={
                  <Button type="button" tone="danger">
                    {t("identity.features.users.ui.userDetailPage.suspend")}
                  </Button>
                }
              >
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="suspend" readOnly />
                  <Button type="submit" tone="danger">
                    {t("identity.features.users.ui.userDetailPage.suspend.confirm.action")}
                  </Button>
                </Form>
              </ModalDialog>
            ) : (
              <Form spacing="none" method="post">
                <HiddenInput type="hidden" name="intent" value="reactivate" readOnly />
                <Button type="submit" tone="primary">
                  {t("identity.features.users.ui.userDetailPage.reactivate")}
                </Button>
              </Form>
            )}
          </Inline>
          <Inline gap={2}>
            <Form spacing="none" method="post">
              <Stack direction="row" align="end" gap={2}>
                <HiddenInput type="hidden" name="intent" value="add-contact-method" readOnly />
                <NativeSelect
                  name="contactMethodType"
                  label={t("identity.features.users.ui.userDetailPage.contact.method.type")}
                  items={contactMethodTypeSelectItems}
                  required
                />
                <TextInput
                  name="contactMethodValue"
                  label={t("identity.features.users.ui.userDetailPage.contact.method.value")}
                  required
                />
                <Button type="submit" tone="secondary">
                  {t("identity.features.users.ui.userDetailPage.add.contact.method")}
                </Button>
              </Stack>
            </Form>
            <Form spacing="none" method="post">
              <Stack direction="row" align="end" gap={2}>
                <HiddenInput type="hidden" name="intent" value="enable-auth-method" readOnly />
                <NativeSelect
                  name="authMethod"
                  label={t("identity.features.users.ui.userDetailPage.auth.method")}
                  items={identityAuthenticationMethodSelectItems}
                  required
                />
                <Button type="submit" tone="secondary">
                  {t("identity.features.users.ui.userDetailPage.enable.auth.method")}
                </Button>
              </Stack>
            </Form>
            <Form spacing="none" method="post">
              <Stack direction="row" align="end" gap={2}>
                <HiddenInput type="hidden" name="intent" value="create-api-key" readOnly />
                <HiddenInput type="hidden" name="userId" value={data.user_id} readOnly />
                <TextInput
                  name="apiKeyName"
                  label={t("identity.features.users.ui.userDetailPage.api.key.name")}
                  required
                />
                <Button type="submit" tone="primary">
                  {t("identity.features.users.ui.userDetailPage.create.api.key")}
                </Button>
              </Stack>
            </Form>
          </Inline>
        </Stack>
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
          label: t("identity.features.users.ui.userDetailPage.contact.methods"),
          value:
            data.contact_methods.length > 0
              ? data.contact_methods.map((method) => (
                  <Stack key={method.contactMethodId} gap={1}>
                    <Text>
                      {contactMethodTypeLabel(method.type)}: {method.value}{" "}
                      {method.verifiedAt
                        ? t("identity.features.users.ui.userDetailPage.verified")
                        : t("identity.features.users.ui.userDetailPage.unverified")}
                    </Text>
                    {!method.verifiedAt ? (
                      <Form spacing="none" method="post">
                        <HiddenInput type="hidden" name="intent" value="verify-contact-method" readOnly />
                        <HiddenInput type="hidden" name="contactMethodId" value={method.contactMethodId} readOnly />
                        <Button type="submit" size="sm" tone="secondary">
                          {t("identity.features.users.ui.userDetailPage.verify")}
                        </Button>
                      </Form>
                    ) : null}
                  </Stack>
                ))
              : t("identity.features.users.ui.userDetailPage.none.3"),
        },
        {
          label: t("identity.features.users.ui.userDetailPage.auth.methods"),
          value:
            data.auth_methods.length > 0
              ? data.auth_methods.map((authMethod) => (
                  <Inline key={authMethod} align="center" gap={2}>
                    <Text>{identityAuthenticationMethodLabel(authMethod)}</Text>
                    <Form spacing="none" method="post">
                      <HiddenInput type="hidden" name="intent" value="disable-auth-method" readOnly />
                      <HiddenInput type="hidden" name="authMethod" value={authMethod} readOnly />
                      <Button type="submit" size="sm" tone="danger">
                        {t("identity.features.users.ui.userDetailPage.disable")}
                      </Button>
                    </Form>
                  </Inline>
                ))
              : t("identity.features.users.ui.userDetailPage.none.4"),
        },
        {
          label: t("identity.features.users.ui.userDetailPage.updated.at"),
          value: formatDateTime(data.updated_at, { fallback: identityDateUnavailable() }),
        },
      ]}
    />
  );
}
