import { t } from "@chase-sets/localization";
import {
  Banner,
  Button,
  Card,
  Inline,
  LinkButton,
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
  getPasskeyCredential,
  type PasskeyCredentialPayload,
} from "../../../support/ui-support/passkey-browser";
import {
  HiddenFields,
  PasskeyHiddenFields,
} from "../../../support/ui-support/auth-hidden-fields";

type SignInMethod = "password" | "magic-link" | "passkey";

export function SignInPage(props: Readonly<{
  action?: string;
  errorMessage?: string | null;
  hiddenFields?: readonly { name: string; value: string }[];
  notice?: AuthActionNotice | null;
  returnTo?: string;
}>) {
  const [method, setMethod] = useState<SignInMethod>("password");
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
      const email = String(formData.get("email") ?? "");
      const payload = await getPasskeyCredential(email);
      setPasskeyPayload(payload);
      window.setTimeout(() => passkeyFormRef.current?.requestSubmit(), 0);
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : t("auth.features.signIn.ui.signInPage.passkey.sign.in.failed"));
    } finally {
      setPasskeyLoading(false);
    }
  }

  const statusMessage =
    props.notice?.status === "magic-link-sent"
      ? t("auth.features.signIn.ui.signInPage.magic.link.ready.check.your.email")
      : null;

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          {t("auth.features.signIn.ui.signInPage.sign.in")}</Text>
        <Text tone="secondary">
          {t("auth.features.signIn.ui.signInPage.use.a.password.magic.link.or")}</Text>
      </Stack>

      {props.errorMessage ? (
        <Banner title={t("auth.features.signIn.ui.signInPage.sign.in.failed")} description={props.errorMessage} tone="danger" role="alert" />
      ) : null}
      {statusMessage ? (
        <Banner
          title={t("auth.features.signIn.ui.signInPage.magic.link.sent")}
          description={statusMessage}
          tone="success"
          actions={
            props.notice?.status === "magic-link-sent" ? (
              <form action={props.action} method="post">
                <HiddenFields fields={props.hiddenFields} />
                <input type="hidden" name="intent" value="magic-link-consume" readOnly />
                <input type="hidden" name="token" value={props.notice.token} readOnly />
                <Button type="submit" tone="secondary" size="sm">
                  {t("auth.features.signIn.ui.signInPage.continue")}</Button>
              </form>
            ) : null
          }
        />
      ) : null}

      <Card>
        <Stack gap={3}>
          <Text size="sm" tone="secondary">
            {t("auth.features.signIn.ui.signInPage.continue.with.social.login")}</Text>
          <Inline>
            <LinkButton
              href={`/api/auth/social/google/start?journey=sign-in&returnTo=${encodeURIComponent(props.returnTo ?? "/account")}`}
              leadingIcon="badgeCheck"
              block
            >
              {t("auth.features.signIn.ui.signInPage.continue.with.google")}</LinkButton>
            <LinkButton
              href={`/api/auth/social/facebook/start?journey=sign-in&returnTo=${encodeURIComponent(props.returnTo ?? "/account")}`}
              leadingIcon="users"
              block
            >
              {t("auth.features.signIn.ui.signInPage.continue.with.facebook")}</LinkButton>
          </Inline>
        </Stack>
      </Card>

      <SegmentedControl
        fullWidth
        value={method}
        onValueChange={(value) => setMethod(value as SignInMethod)}
        items={[
          { value: "password", label: t("auth.features.signIn.ui.signInPage.password"), icon: "lock" },
          { value: "magic-link", label: t("auth.features.signIn.ui.signInPage.magic.link"), icon: "message" },
          { value: "passkey", label: t("auth.features.signIn.ui.signInPage.passkey"), icon: "shield" },
        ]}
      />

      {method === "password" ? (
        <Card>
          <form action={props.action} method="post">
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <input type="hidden" name="intent" value="password" readOnly />
              <TextInput label={t("auth.features.signIn.ui.signInPage.email")} name="email" type="email" required />
              <PasswordInput label={t("auth.features.signIn.ui.signInPage.password.2")} name="password" required />
              <Button type="submit" leadingIcon="lock">
                {t("auth.features.signIn.ui.signInPage.sign.in.2")}</Button>
            </Stack>
          </form>
        </Card>
      ) : null}

      {method === "magic-link" ? (
        <Card>
          <Stack gap={4}>
            <form action={props.action} method="post">
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <input type="hidden" name="intent" value="magic-link-request" readOnly />
                <TextInput label={t("auth.features.signIn.ui.signInPage.email.2")} name="email" type="email" required />
                <Button type="submit" leadingIcon="message">
                  {t("auth.features.signIn.ui.signInPage.send.magic.link")}</Button>
              </Stack>
            </form>
            <form action={props.action} method="post">
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <input type="hidden" name="intent" value="magic-link-consume" readOnly />
                <TextInput label={t("auth.features.signIn.ui.signInPage.magic.link.token")} name="token" required />
                <Button type="submit" tone="secondary">
                  {t("auth.features.signIn.ui.signInPage.continue.with.token")}</Button>
              </Stack>
            </form>
          </Stack>
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
              <input type="hidden" name="intent" value="passkey-sign-in" readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <TextInput label={t("auth.features.signIn.ui.signInPage.email.3")} name="email" type="email" required />
              {passkeyError ? (
                <Banner title={t("auth.features.signIn.ui.signInPage.passkey.unavailable")} description={passkeyError} tone="warning" role="alert" />
              ) : null}
              <Button type="submit" leadingIcon="shield" loading={passkeyLoading}>
                {t("auth.features.signIn.ui.signInPage.use.passkey")}</Button>
            </Stack>
          </form>
        </Card>
      ) : null}
    </Stack>
  );
}
