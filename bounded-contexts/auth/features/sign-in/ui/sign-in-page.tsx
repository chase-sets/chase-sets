import { t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Banner,
  Button,
  Card,
  Heading,
  Inline,
  LinkButton,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  ValidationSummary,
  type SegmentedControlItem,
} from "@chase-sets/design-system";
import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import {
  DEFAULT_SIGN_IN_METHODS,
  type AuthActionNotice,
  type SignInMethod,
} from "../../../support/route-support/auth-host";
import { getPasskeyCredential, type PasskeyCredentialPayload } from "../../../support/ui-support/passkey-browser";
import { HiddenFields, PasskeyHiddenFields } from "../../../support/ui-support/auth-hidden-fields";
import {
  authFormErrors,
  useAuthFormFeedback,
  type AuthFormFeedbackProps,
} from "../../../support/ui-support/auth-form-feedback";

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
  { value: "magic-link", labelKey: "auth.features.signIn.ui.signInPage.magic.link", icon: "mail" },
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
  props: AuthFormFeedbackProps &
    Readonly<{
      action?: string;
      contextMessage?: Readonly<{ title: string; description: string }> | null;
      hiddenFields?: readonly { name: string; value: string }[];
      initialIdentifier?: string | null;
      initialMethod?: string | null;
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
  const identifierId = useId();
  const methodsId = useId();
  const passwordId = useId();
  const codeId = useId();
  const tokenId = useId();
  const methodButtonId = useId();
  const identifierFocus = useRef<"methods" | "identifier" | null>(null);
  const warningRef = useRef<HTMLDivElement>(null);
  const feedback = useAuthFormFeedback(
    props,
    props.notice?.status === "phone-code-sent" ? codeId : props.allowManualMagicLinkTokenEntry ? tokenId : undefined,
  );
  const { summary } = authFormErrors(feedback.error);
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

  useEffect(() => {
    if (identifierFocus.current) {
      const target =
        identifierFocus.current === "identifier"
          ? document.getElementById(identifierId)
          : (document.getElementById(methodsId)?.querySelector<HTMLElement>('[aria-checked="true"]') ??
            document.getElementById(method === "password" ? passwordId : methodButtonId));
      target?.focus();
      identifierFocus.current = null;
    }
  }, [hasIdentifier, identifier, identifierId, method, methodButtonId, methodsId, passwordId]);

  useEffect(() => {
    if (passkeyError) warningRef.current?.focus();
  }, [passkeyError]);

  function handleServerSubmit(event: FormEvent<HTMLFormElement>) {
    feedback.begin();
    setPasskeyError(null);
    props.onSubmit?.(event);
  }

  function selectMethod(nextMethod: SignInMethod) {
    feedback.clear();
    setPasskeyError(null);
    setPasskeyPayload(null);
    setPasskeyLoading(false);
    setMethod(nextMethod);
  }

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
    feedback.clear();
    identifierFocus.current = "methods";
  }

  function handleChangeIdentifier() {
    setIdentifier("");
    setIdentifierKind(null);
    setPasskeyPayload(null);
    setPasskeyError(null);
    feedback.clear();
    identifierFocus.current = "identifier";
  }

  async function handlePasskeySubmit(event: FormEvent<HTMLFormElement>) {
    if (passkeyPayload) {
      handleServerSubmit(event);
      return;
    }

    event.preventDefault();
    feedback.begin();
    setPasskeyError(null);
    setPasskeyLoading(true);
    const form = event.currentTarget;

    try {
      const formData = new FormData(event.currentTarget);
      const email = String(formData.get("email") ?? "");
      const payload = await getPasskeyCredential(email);
      if (passkeyFormRef.current !== form) return;
      setPasskeyPayload(payload);
      window.setTimeout(() => {
        if (passkeyFormRef.current === form) form.requestSubmit();
      }, 0);
    } catch {
      if (passkeyFormRef.current === form)
        setPasskeyError(t("auth.features.signIn.ui.signInPage.passkey.sign.in.failed"));
    } finally {
      if (passkeyFormRef.current === form) setPasskeyLoading(false);
    }
  }

  const statusMessage =
    feedback.notice?.status === "magic-link-sent"
      ? t("auth.features.signIn.ui.signInPage.magic.link.ready.check.your.email")
      : feedback.notice?.status === "phone-code-sent"
        ? t("auth.features.signIn.ui.signInPage.phone.code.ready.check.your.phone")
        : null;

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Heading level={1} visualSize={5}>
          {t("auth.features.signIn.ui.signInPage.sign.in")}
        </Heading>
        <Text tone="secondary">{t("auth.features.signIn.ui.signInPage.use.social.email.or.phone")}</Text>
      </Stack>

      {props.contextMessage ? (
        <Banner title={props.contextMessage.title} description={props.contextMessage.description} tone="info" />
      ) : null}

      <ValidationSummary
        ref={feedback.summaryRef}
        title={t("auth.features.signIn.ui.signInPage.sign.in.failed")}
        errors={summary}
      />
      {!feedback.error && feedback.socialError ? (
        <Banner
          ref={feedback.socialRef}
          title={t("auth.features.signIn.ui.signInPage.sign.in.failed")}
          description={feedback.socialError}
          tone="danger"
          role="alert"
          tabIndex={-1}
        />
      ) : null}
      {statusMessage ? (
        <Banner
          ref={feedback.successRef}
          tabIndex={-1}
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
          <Card elevation="flush">
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

          <Card elevation="elevated">
            <Stack gap={4}>
              {signInMethods.length > 0 ? (
                <Stack gap={2}>
                  <Text size="sm" tone="secondary">
                    {t("auth.features.signIn.ui.signInPage.you.can.sign.in.with")}
                  </Text>
                  <Stack gap={1} role="list">
                    {SIGN_IN_METHOD_ITEMS.filter((item) => signInMethods.includes(item.value)).map((item) => (
                      <Text key={item.value} size="sm" role="listitem">
                        {t(item.labelKey)}
                      </Text>
                    ))}
                  </Stack>
                </Stack>
              ) : null}
              <Form spacing="none" onSubmit={handleIdentifierSubmit}>
                <Stack gap={3}>
                  {props.returnTo ? (
                    <HiddenInput type="hidden" name="returnTo" value={props.returnTo} readOnly />
                  ) : null}
                  {signInMethods.includes("password") ? (
                    <HiddenInput type="hidden" name="signInMethod" value="password" readOnly />
                  ) : null}
                  <TextInput
                    id={identifierId}
                    label={t("auth.features.signIn.ui.signInPage.email.or.phone")}
                    name="signInIdentifier"
                    autoComplete="username"
                    required
                  />
                  <Button type="submit">{t("auth.features.signIn.ui.signInPage.continue")}</Button>
                </Stack>
              </Form>
            </Stack>
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
              id={methodsId}
              fullWidth
              label={t("auth.features.signIn.ui.signInPage.method")}
              value={method}
              onValueChange={(value) => selectMethod(value as SignInMethod)}
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
        <Card elevation="elevated">
          <Form spacing="none" action={props.action} method="post" onSubmit={handleServerSubmit}>
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <HiddenInput type="hidden" name="intent" value="password" readOnly />
              <HiddenInput type="hidden" name="email" value={identifier} readOnly />
              <PasswordInput
                id={passwordId}
                label={t("auth.features.signIn.ui.signInPage.password.2")}
                name="password"
                autoComplete="current-password"
                required
              />
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
        <Card elevation="elevated">
          <Stack gap={4}>
            <Form spacing="none" action={props.action} method="post" onSubmit={handleServerSubmit}>
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <HiddenInput type="hidden" name="intent" value="phone-code-request" readOnly />
                <HiddenInput type="hidden" name="phone" value={identifier} readOnly />
                <Button id={methodButtonId} type="submit" leadingIcon="message">
                  {t("auth.features.signIn.ui.signInPage.send.phone.code")}
                </Button>
              </Stack>
            </Form>
            <Form spacing="none" action={props.action} method="post" onSubmit={handleServerSubmit}>
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
                  id={codeId}
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
        <Card elevation="elevated">
          <Stack gap={4}>
            <Text size="sm" tone="secondary">
              {t("auth.features.signIn.ui.signInPage.magic.link.description")}
            </Text>
            <Form spacing="none" action={props.action} method="post" onSubmit={handleServerSubmit}>
              <Stack gap={3}>
                <HiddenFields fields={props.hiddenFields} />
                <HiddenInput type="hidden" name="intent" value="magic-link-request" readOnly />
                <HiddenInput type="hidden" name="email" value={identifier} readOnly />
                <Button id={methodButtonId} type="submit" leadingIcon="mail">
                  {t("auth.features.signIn.ui.signInPage.send.magic.link")}
                </Button>
              </Stack>
            </Form>
            {props.allowManualMagicLinkTokenEntry ? (
              <Form spacing="none" action={props.action} method="post" onSubmit={handleServerSubmit}>
                <Stack gap={3}>
                  <HiddenFields fields={props.hiddenFields} />
                  <HiddenInput type="hidden" name="intent" value="magic-link-consume" readOnly />
                  <HiddenInput type="hidden" name="email" value={identifier} readOnly />
                  <TextInput
                    id={tokenId}
                    label={t("auth.features.signIn.ui.signInPage.magic.link.token")}
                    name="token"
                    required
                  />
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
        <Card elevation="elevated">
          <Form spacing="none" ref={passkeyFormRef} action={props.action} method="post" onSubmit={handlePasskeySubmit}>
            <Stack gap={3}>
              <HiddenFields fields={props.hiddenFields} />
              <HiddenInput type="hidden" name="intent" value="passkey-sign-in" readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <HiddenInput type="hidden" name="email" value={identifier} readOnly />
              {passkeyError ? (
                <Banner
                  ref={warningRef}
                  tabIndex={-1}
                  title={t("auth.features.signIn.ui.signInPage.passkey.unavailable")}
                  description={passkeyError}
                  tone="warning"
                  role="alert"
                />
              ) : null}
              <Button id={methodButtonId} type="submit" leadingIcon="shield" loading={passkeyLoading}>
                {t("auth.features.signIn.ui.signInPage.use.passkey")}
              </Button>
            </Stack>
          </Form>
        </Card>
      ) : null}
    </Stack>
  );
}
