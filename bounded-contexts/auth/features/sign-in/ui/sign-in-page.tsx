import { t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
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
  type SegmentedControlItem,
} from "@chase-sets/design-system";
import type { FormEvent } from "react";
import { useRef, useState } from "react";
import {
  DEFAULT_SIGN_IN_METHODS,
  type AuthActionNotice,
  type SignInMethod,
} from "../../../support/route-support/auth-host";
import { getPasskeyCredential, type PasskeyCredentialPayload } from "../../../support/ui-support/passkey-browser";
import { HiddenFields, PasskeyHiddenFields } from "../../../support/ui-support/auth-hidden-fields";

type SignInMethodItem = SegmentedControlItem & Readonly<{ value: SignInMethod }>;
type SignInIdentifierKind = "email" | "phone";
type SocialLoginLink = Readonly<{
  href: string;
  label: string;
  icon: "badgeCheck" | "users";
}>;

const SIGN_IN_METHOD_ITEMS = [
  { value: "password", labelKey: "auth.features.signIn.ui.signInPage.password", icon: "lock" },
  { value: "phone-code", labelKey: "auth.features.signIn.ui.signInPage.phone.code", icon: "message" },
  { value: "magic-link", labelKey: "auth.features.signIn.ui.signInPage.magic.link", icon: "message" },
  { value: "passkey", labelKey: "auth.features.signIn.ui.signInPage.passkey", icon: "shield" },
] as const satisfies readonly Readonly<{
  value: SignInMethod;
  labelKey: string;
  icon: SignInMethodItem["icon"];
}>[];

const EMAIL_METHOD_PRIORITY = ["passkey", "magic-link", "password"] as const satisfies readonly SignInMethod[];

const PHONE_METHOD_PRIORITY = ["phone-code"] as const satisfies readonly SignInMethod[];

function detectIdentifierKind(identifier: string): SignInIdentifierKind {
  return identifier.includes("@") ? "email" : "phone";
}

function methodItemsForIdentifier(
  kind: SignInIdentifierKind,
  signInMethods: readonly SignInMethod[],
): SignInMethodItem[] {
  const priority = kind === "email" ? EMAIL_METHOD_PRIORITY : PHONE_METHOD_PRIORITY;
  return priority
    .filter((method) => signInMethods.includes(method))
    .map((method) => {
      const item = SIGN_IN_METHOD_ITEMS.find((candidate) => candidate.value === method);
      if (!item) {
        throw new Error(`Unsupported sign-in method: ${method}`);
      }

      return {
        value: item.value,
        label: t(item.labelKey),
        icon: item.icon,
      };
    });
}

function identifierFromNotice(notice: AuthActionNotice | null | undefined) {
  if (notice?.status === "phone-code-sent") {
    return notice.phone;
  }

  if (notice?.status === "magic-link-sent") {
    return notice.email ?? "";
  }

  return "";
}

function resolveInitialMethod(
  method: string | null | undefined,
  availableMethods: readonly SignInMethodItem[],
  fallback: SignInMethod,
) {
  return availableMethods.some((item) => item.value === method) ? (method as SignInMethod) : fallback;
}

export function SignInPage(
  props: Readonly<{
    action?: string;
    contextMessage?: Readonly<{ title: string; description: string }> | null;
    errorMessage?: string | null;
    hiddenFields?: readonly { name: string; value: string }[];
    initialIdentifier?: string | null;
    initialMethod?: string | null;
    notice?: AuthActionNotice | null;
    returnTo?: string;
    signInMethods?: readonly SignInMethod[];
    allowManualMagicLinkTokenEntry?: boolean;
    socialLoginDescription?: string;
    socialLoginLinks?: readonly SocialLoginLink[];
  }>,
) {
  const signInMethods = props.signInMethods ?? DEFAULT_SIGN_IN_METHODS;
  const initialIdentifier = identifierFromNotice(props.notice) || props.initialIdentifier?.trim() || "";
  const initialIdentifierKind = initialIdentifier ? detectIdentifierKind(initialIdentifier) : null;
  const initialMethodItems = initialIdentifierKind
    ? methodItemsForIdentifier(initialIdentifierKind, signInMethods)
    : [];
  const initialMethod =
    props.notice?.status === "phone-code-sent" && signInMethods.includes("phone-code")
      ? "phone-code"
      : props.notice?.status === "magic-link-sent" && signInMethods.includes("magic-link")
        ? "magic-link"
        : resolveInitialMethod(props.initialMethod, initialMethodItems, initialMethodItems[0]?.value ?? "password");
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [identifierKind, setIdentifierKind] = useState<SignInIdentifierKind | null>(initialIdentifierKind);
  const [method, setMethod] = useState<SignInMethod>(initialMethod);
  const [passkeyPayload, setPasskeyPayload] = useState<PasskeyCredentialPayload | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const passkeyFormRef = useRef<HTMLFormElement | null>(null);
  const challengeMethods = identifierKind ? methodItemsForIdentifier(identifierKind, signInMethods) : [];
  const hasIdentifier = identifier.trim().length > 0 && identifierKind !== null;
  const socialLoginLinks =
    props.socialLoginLinks ??
    ([
      {
        href: `/api/auth/social/google/start?journey=sign-in&returnTo=${encodeURIComponent(props.returnTo ?? "/account")}`,
        label: t("auth.features.signIn.ui.signInPage.continue.with.google"),
        icon: "badgeCheck",
      },
      {
        href: `/api/auth/social/facebook/start?journey=sign-in&returnTo=${encodeURIComponent(props.returnTo ?? "/account")}`,
        label: t("auth.features.signIn.ui.signInPage.continue.with.facebook"),
        icon: "users",
      },
    ] as const satisfies readonly SocialLoginLink[]);

  function handleIdentifierSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const nextIdentifier = String(formData.get("signInIdentifier") ?? "").trim();
    if (!nextIdentifier) {
      return;
    }

    const nextKind = detectIdentifierKind(nextIdentifier);
    const nextMethods = methodItemsForIdentifier(nextKind, signInMethods);
    setIdentifier(nextIdentifier);
    setIdentifierKind(nextKind);
    setMethod(nextMethods[0]?.value ?? "password");
    setPasskeyPayload(null);
    setPasskeyError(null);
  }

  function handleChangeIdentifier() {
    setIdentifier("");
    setIdentifierKind(null);
    setPasskeyPayload(null);
    setPasskeyError(null);
  }

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
      setPasskeyError(
        error instanceof Error ? error.message : t("auth.features.signIn.ui.signInPage.passkey.sign.in.failed"),
      );
    } finally {
      setPasskeyLoading(false);
    }
  }

  const statusMessage =
    props.notice?.status === "magic-link-sent"
      ? t("auth.features.signIn.ui.signInPage.magic.link.ready.check.your.email")
      : props.notice?.status === "phone-code-sent"
        ? t("auth.features.signIn.ui.signInPage.phone.code.ready.check.your.phone")
        : null;

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          {t("auth.features.signIn.ui.signInPage.sign.in")}
        </Text>
        <Text tone="secondary">{t("auth.features.signIn.ui.signInPage.use.social.email.or.phone")}</Text>
      </Stack>

      {props.contextMessage ? (
        <Banner title={props.contextMessage.title} description={props.contextMessage.description} tone="info" />
      ) : null}

      {props.errorMessage ? (
        <Banner
          title={t("auth.features.signIn.ui.signInPage.sign.in.failed")}
          description={props.errorMessage}
          tone="danger"
          role="alert"
        />
      ) : null}
      {statusMessage ? (
        <Banner
          title={
            props.notice?.status === "phone-code-sent"
              ? t("auth.features.signIn.ui.signInPage.phone.code.sent")
              : t("auth.features.signIn.ui.signInPage.magic.link.sent")
          }
          description={statusMessage}
          tone="success"
        />
      ) : null}

      {!hasIdentifier ? (
        <>
          <Card>
            <Stack gap={3}>
              <Text size="sm" tone="secondary">
                {props.socialLoginDescription ?? t("auth.features.signIn.ui.signInPage.continue.with.social.login")}
              </Text>
              <Inline>
                {socialLoginLinks.map((link) => (
                  <LinkButton key={link.href} href={link.href} leadingIcon={link.icon} block>
                    {link.label}
                  </LinkButton>
                ))}
              </Inline>
            </Stack>
          </Card>

          <Card>
            <Form spacing="none" onSubmit={handleIdentifierSubmit}>
              <Stack gap={3}>
                {props.returnTo ? <HiddenInput type="hidden" name="returnTo" value={props.returnTo} readOnly /> : null}
                {signInMethods.includes("password") ? (
                  <HiddenInput type="hidden" name="signInMethod" value="password" readOnly />
                ) : null}
                <TextInput
                  label={t("auth.features.signIn.ui.signInPage.email.or.phone")}
                  name="signInIdentifier"
                  autoComplete="username"
                  required
                />
                <Button type="submit">{t("auth.features.signIn.ui.signInPage.continue")}</Button>
              </Stack>
            </Form>
          </Card>
        </>
      ) : null}

      {hasIdentifier ? (
        <Stack gap={3}>
          <Inline>
            <Text size="sm" tone="secondary">
              {t("auth.features.signIn.ui.signInPage.signing.in.with", {
                identifier,
              })}
            </Text>
            <Button type="button" tone="secondary" size="sm" onClick={handleChangeIdentifier}>
              {t("auth.features.signIn.ui.signInPage.change")}
            </Button>
          </Inline>
          {challengeMethods.length > 1 ? (
            <SegmentedControl
              fullWidth
              label={t("auth.features.signIn.ui.signInPage.method")}
              value={method}
              onValueChange={(value) => setMethod(value as SignInMethod)}
              items={challengeMethods}
            />
          ) : null}
        </Stack>
      ) : null}

      {hasIdentifier && challengeMethods.length === 0 ? (
        <Banner
          title={t("auth.features.signIn.ui.signInPage.no.compatible.methods")}
          description={t("auth.features.signIn.ui.signInPage.try.a.different.identifier")}
          tone="warning"
        />
      ) : null}

      {hasIdentifier && identifierKind === "email" && method === "password" && signInMethods.includes("password") ? (
        <Card>
          <Form spacing="none" action={props.action} method="post">
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <HiddenInput type="hidden" name="intent" value="password" readOnly />
              <HiddenInput type="hidden" name="email" value={identifier} readOnly />
              <PasswordInput label={t("auth.features.signIn.ui.signInPage.password.2")} name="password" required />
              <Button type="submit" leadingIcon="lock">
                {t("auth.features.signIn.ui.signInPage.sign.in.2")}
              </Button>
            </Stack>
          </Form>
        </Card>
      ) : null}

      {hasIdentifier &&
      identifierKind === "phone" &&
      method === "phone-code" &&
      signInMethods.includes("phone-code") ? (
        <Card>
          <Stack gap={4}>
            <Form spacing="none" action={props.action} method="post">
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <HiddenInput type="hidden" name="intent" value="phone-code-request" readOnly />
                <HiddenInput type="hidden" name="phone" value={identifier} readOnly />
                <Button type="submit" leadingIcon="message">
                  {t("auth.features.signIn.ui.signInPage.send.phone.code")}
                </Button>
              </Stack>
            </Form>
            <Form spacing="none" action={props.action} method="post">
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <HiddenInput type="hidden" name="intent" value="phone-code-consume" readOnly />
                <HiddenInput
                  type="hidden"
                  name="tokenId"
                  value={props.notice?.status === "phone-code-sent" ? props.notice.tokenId : ""}
                  readOnly
                />
                <HiddenInput type="hidden" name="phone" value={identifier} readOnly />
                <TextInput
                  label={t("auth.features.signIn.ui.signInPage.phone.code.2")}
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  required
                />
                <Button type="submit" tone="secondary">
                  {t("auth.features.signIn.ui.signInPage.continue.with.code")}
                </Button>
              </Stack>
            </Form>
          </Stack>
        </Card>
      ) : null}

      {hasIdentifier &&
      identifierKind === "email" &&
      method === "magic-link" &&
      signInMethods.includes("magic-link") ? (
        <Card>
          <Stack gap={4}>
            <Form spacing="none" action={props.action} method="post">
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <HiddenInput type="hidden" name="intent" value="magic-link-request" readOnly />
                <HiddenInput type="hidden" name="email" value={identifier} readOnly />
                <Button type="submit" leadingIcon="message">
                  {t("auth.features.signIn.ui.signInPage.send.magic.link")}
                </Button>
              </Stack>
            </Form>
            {props.allowManualMagicLinkTokenEntry ? (
              <Form spacing="none" action={props.action} method="post">
                <Stack gap={3}>
                  <HiddenFields fields={props.hiddenFields} />
                  <HiddenInput type="hidden" name="intent" value="magic-link-consume" readOnly />
                  <TextInput label={t("auth.features.signIn.ui.signInPage.magic.link.token")} name="token" required />
                  <Button type="submit" tone="secondary">
                    {t("auth.features.signIn.ui.signInPage.continue.with.token")}
                  </Button>
                </Stack>
              </Form>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {hasIdentifier && identifierKind === "email" && method === "passkey" && signInMethods.includes("passkey") ? (
        <Card>
          <Form spacing="none" ref={passkeyFormRef} action={props.action} method="post" onSubmit={handlePasskeySubmit}>
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <HiddenInput type="hidden" name="intent" value="passkey-sign-in" readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <HiddenInput type="hidden" name="email" value={identifier} readOnly />
              {passkeyError ? (
                <Banner
                  title={t("auth.features.signIn.ui.signInPage.passkey.unavailable")}
                  description={passkeyError}
                  tone="warning"
                  role="alert"
                />
              ) : null}
              <Button type="submit" leadingIcon="shield" loading={passkeyLoading}>
                {t("auth.features.signIn.ui.signInPage.use.passkey")}
              </Button>
            </Stack>
          </Form>
        </Card>
      ) : null}
    </Stack>
  );
}
