import { t } from "@chase-sets/localization";
import {
  Banner,
  Button,
  Card,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import type { AuthActionNotice } from "../../../support/route-support/auth-host";
import {
  createPasskeyCredential,
  type PasskeyCredentialPayload,
} from "../../../support/ui-support/passkey-browser";
import {
  HiddenFields,
  PasskeyHiddenFields,
} from "../../../support/ui-support/auth-hidden-fields";

type RegistrationMethod = "password" | "passkey";

export function RegisterPage(props: Readonly<{
  action?: string;
  errorMessage?: string | null;
  hiddenFields?: readonly { name: string; value: string }[];
  notice?: AuthActionNotice | null;
}>) {
  const [method, setMethod] = useState<RegistrationMethod>("password");
  const [passkeyPayload, setPasskeyPayload] =
    useState<PasskeyCredentialPayload | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const passkeyFormRef = useRef<HTMLFormElement | null>(null);

  async function handlePasskeySubmit(event: FormEvent<HTMLFormElement>) {
    if (passkeyPayload) {
      return;
    }

    event.preventDefault();
    setPasskeyError(null);
    setPasskeyLoading(true);

    try {
      const formData = new FormData(event.currentTarget);
      const displayName = String(formData.get("displayName") ?? "");
      const email = String(formData.get("email") ?? "");
      const payload = await createPasskeyCredential({ displayName, email });
      setPasskeyPayload(payload);
      window.setTimeout(() => passkeyFormRef.current?.requestSubmit(), 0);
    } catch (error) {
      setPasskeyError(
        error instanceof Error ? error.message : t("auth.features.registration.ui.registerPage.passkey.registration.failed"),
      );
    } finally {
      setPasskeyLoading(false);
    }
  }

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          {t("auth.features.registration.ui.registerPage.create.account")}</Text>
        <Text tone="secondary">
          {t("auth.features.registration.ui.registerPage.create.your.personal.identity.and.owner")}</Text>
      </Stack>

      {props.errorMessage ? (
        <Banner
          title={t("auth.features.registration.ui.registerPage.registration.failed")}
          description={props.errorMessage}
          tone="danger"
          role="alert"
        />
      ) : null}
      {props.notice?.status === "passkey-recovery" ? (
        <Banner title={t("auth.features.registration.ui.registerPage.passkey.added")} description={props.notice.message} tone="success" />
      ) : null}

      <SegmentedControl
        fullWidth
        value={method}
        onValueChange={(value) => setMethod(value as RegistrationMethod)}
        items={[
          { value: "password", label: t("auth.features.registration.ui.registerPage.password"), icon: "lock" },
          { value: "passkey", label: t("auth.features.registration.ui.registerPage.passkey"), icon: "shield" },
        ]}
      />

      {method === "password" ? (
        <Card>
          <form action={props.action} method="post">
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <input type="hidden" name="intent" value="password" readOnly />
              <TextInput label={t("auth.features.registration.ui.registerPage.display.name")} name="displayName" required />
              <TextInput label={t("auth.features.registration.ui.registerPage.email")} name="email" type="email" required />
              <PasswordInput label={t("auth.features.registration.ui.registerPage.password.2")} name="password" required />
              <Button type="submit" leadingIcon="lock">
                {t("auth.features.registration.ui.registerPage.create.account.2")}</Button>
            </Stack>
          </form>
        </Card>
      ) : null}

      {method === "passkey" ? (
        <Card>
          <form
            ref={passkeyFormRef}
            action={props.action}
            method="post"
            onSubmit={handlePasskeySubmit}
          >
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <input type="hidden" name="intent" value="passkey-register" readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <TextInput label={t("auth.features.registration.ui.registerPage.display.name.2")} name="displayName" required />
              <TextInput label={t("auth.features.registration.ui.registerPage.email.2")} name="email" type="email" required />
              {passkeyError ? (
                <Banner
                  title={t("auth.features.registration.ui.registerPage.passkey.unavailable")}
                  description={passkeyError}
                  tone="warning"
                  role="alert"
                />
              ) : null}
              <Button type="submit" leadingIcon="shield" loading={passkeyLoading}>
                {t("auth.features.registration.ui.registerPage.create.with.passkey")}</Button>
            </Stack>
          </form>
        </Card>
      ) : null}
    </Stack>
  );
}
