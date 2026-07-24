import { t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  Banner,
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Heading,
  Inline,
  LinkButton,
  LinkText,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  type IconName,
} from "@chase-sets/design-system";
import type { FormEvent, ReactNode, Ref } from "react";
import { useEffect, useRef, useState } from "react";
import type { AuthActionNotice } from "../../../support/route-support/auth-host";
import { createPasskeyCredential, type PasskeyCredentialPayload } from "../../../support/ui-support/passkey-browser";
import { HiddenFields, PasskeyHiddenFields } from "../../../support/ui-support/auth-hidden-fields";

type RegistrationMethod = "passkey" | "phone-code" | "magic-link" | "password";
type RegistrationAnalyticsStage = "shown" | "selected" | "completed" | "abandoned" | "failed";

const DEFAULT_REGISTRATION_METHOD: RegistrationMethod = "passkey";
const REGISTRATION_METHOD_OPTIONS: readonly {
  value: RegistrationMethod;
  labelKey: string;
  icon: IconName;
}[] = [
  {
    value: "passkey",
    labelKey: "auth.features.registration.ui.registerPage.passkey",
    icon: "shield",
  },
  {
    value: "phone-code",
    labelKey: "auth.features.registration.ui.registerPage.phone.code",
    icon: "message",
  },
  {
    value: "magic-link",
    labelKey: "auth.features.registration.ui.registerPage.magic.link",
    icon: "message",
  },
  {
    value: "password",
    labelKey: "auth.features.registration.ui.registerPage.password",
    icon: "lock",
  },
];

const registrationMethods = REGISTRATION_METHOD_OPTIONS.map((option) => option.value);
const registrationMethodsShown = registrationMethods.join(",");

type RegistrationDetails = Readonly<{
  displayName: string;
  email: string;
  phone: string;
  phoneCode: string;
  password: string;
}>;

type RegistrationPageProps = Readonly<{
  action?: string;
  errorMessage?: string | null;
  hiddenFields?: readonly { name: string; value: string }[];
  contextMessage?: Readonly<{ title: string; description: string }> | null;
  notice?: AuthActionNotice | null;
  returnTo?: string;
}>;

type RegistrationFormCardProps = Readonly<{
  action?: string;
  children: ReactNode;
  formRef?: Ref<HTMLFormElement>;
  glow?: boolean;
  hiddenFields?: RegistrationPageProps["hiddenFields"];
  intent: string;
  method: RegistrationMethod;
  consentAffirmed: boolean;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}>;

type IdentityFieldsProps = Readonly<{
  details: RegistrationDetails;
  onChange: (field: keyof RegistrationDetails, value: string) => void;
}>;

function registrationMethodPriority(method: RegistrationMethod) {
  return registrationMethods.indexOf(method) + 1;
}

function trackRegistrationAnalytics(
  event: Readonly<{
    method: RegistrationMethod;
    stage: RegistrationAnalyticsStage;
    reason?: string;
  }>,
) {
  if (typeof window === "undefined") {
    return;
  }

  const payload = {
    flow: "registration",
    priority: registrationMethodPriority(event.method),
    presentedMethods: registrationMethods,
    ...event,
  };

  window.dispatchEvent(
    new CustomEvent("chase-sets:registration-method", {
      detail: payload,
    }),
  );

  const analyticsWindow = window as Window & {
    dataLayer?: { push: (value: unknown) => void };
  };
  analyticsWindow.dataLayer?.push({
    event: "registration_method",
    ...payload,
  });
}

function RegistrationFormCard({
  action,
  children,
  formRef,
  glow = false,
  hiddenFields,
  intent,
  method,
  consentAffirmed,
  onSubmit,
}: RegistrationFormCardProps) {
  return (
    <Card glow={glow}>
      <Form spacing="none" ref={formRef} action={action} method="post" onSubmit={onSubmit}>
        <Stack gap={3}>
          <HiddenFields fields={hiddenFields} />
          <HiddenInput type="hidden" name="registrationMethod" value={method} readOnly />
          <HiddenInput type="hidden" name="registrationMethodsShown" value={registrationMethodsShown} readOnly />
          <HiddenInput type="hidden" name="intent" value={intent} readOnly />
          <HiddenInput type="hidden" name="consentAffirmed" value={consentAffirmed ? "true" : "false"} readOnly />
          {children}
        </Stack>
      </Form>
    </Card>
  );
}

function IdentityFields({ details, onChange }: IdentityFieldsProps) {
  return (
    <>
      <TextInput
        label={t("auth.features.registration.ui.registerPage.display.name")}
        name="displayName"
        autoComplete="name"
        required
        value={details.displayName}
        onChange={(event) => onChange("displayName", event.currentTarget.value)}
      />
      <TextInput
        label={t("auth.features.registration.ui.registerPage.email")}
        name="email"
        type="email"
        autoComplete="email"
        required
        value={details.email}
        onChange={(event) => onChange("email", event.currentTarget.value)}
      />
    </>
  );
}

export function RegisterPage(props: RegistrationPageProps) {
  const [method, setMethod] = useState<RegistrationMethod>(
    props.notice?.status === "phone-code-sent" ? "phone-code" : DEFAULT_REGISTRATION_METHOD,
  );
  const [details, setDetails] = useState<RegistrationDetails>({
    displayName: props.notice?.status === "phone-code-sent" ? (props.notice.displayName ?? "") : "",
    email: "",
    phone: props.notice?.status === "phone-code-sent" ? props.notice.phone : "",
    phoneCode: "",
    password: "",
  });
  const [passkeyPayload, setPasskeyPayload] = useState<PasskeyCredentialPayload | null>(null);
  const [consentAffirmed, setConsentAffirmed] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const passkeyFormRef = useRef<HTMLFormElement | null>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    registrationMethods.forEach((shownMethod) => {
      trackRegistrationAnalytics({
        method: shownMethod,
        stage: "shown",
      });
    });
  }, []);

  useEffect(() => {
    if (!props.errorMessage) {
      return;
    }

    trackRegistrationAnalytics({
      method,
      stage: "failed",
      reason: props.errorMessage,
    });
  }, [method, props.errorMessage]);

  useEffect(() => {
    function handleAbandoned() {
      if (!submittedRef.current) {
        trackRegistrationAnalytics({ method, stage: "abandoned" });
      }
    }

    window.addEventListener("beforeunload", handleAbandoned);
    return () => window.removeEventListener("beforeunload", handleAbandoned);
  }, [method]);

  function updateDetails(field: keyof RegistrationDetails, value: string) {
    setDetails((current) => ({ ...current, [field]: value }));
  }

  function selectMethod(nextMethod: RegistrationMethod) {
    setMethod(nextMethod);
    trackRegistrationAnalytics({ method: nextMethod, stage: "selected" });
  }

  function handleCompleted(methodCompleted: RegistrationMethod) {
    submittedRef.current = true;
    trackRegistrationAnalytics({ method: methodCompleted, stage: "completed" });
  }

  async function handlePasskeySubmit(event: FormEvent<HTMLFormElement>) {
    if (passkeyPayload) {
      handleCompleted("passkey");
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
      const message =
        error instanceof Error
          ? error.message
          : t("auth.features.registration.ui.registerPage.passkey.registration.failed");
      setPasskeyError(message);
      trackRegistrationAnalytics({
        method: "passkey",
        stage: "failed",
        reason: message,
      });
    } finally {
      setPasskeyLoading(false);
    }
  }

  const fallbackAction = (
    <Button type="button" tone="secondary" size="sm" onClick={() => selectMethod("magic-link")}>
      {t("auth.features.registration.ui.registerPage.use.magic.link")}
    </Button>
  );

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Heading level={1} visualSize={5}>
          {t("auth.features.registration.ui.registerPage.create.account")}
        </Heading>
        <Text tone="secondary">
          {t("auth.features.registration.ui.registerPage.create.your.personal.identity.and.owner")}
        </Text>
      </Stack>

      {props.contextMessage ? (
        <Banner title={props.contextMessage.title} description={props.contextMessage.description} tone="info" />
      ) : null}

      {props.errorMessage ? (
        <Banner
          title={t("auth.features.registration.ui.registerPage.registration.failed")}
          description={props.errorMessage}
          tone="danger"
          role="alert"
        />
      ) : null}
      {props.notice?.status === "passkey-recovery" ? (
        <Banner
          title={t("auth.features.registration.ui.registerPage.passkey.added")}
          description={props.notice.message}
          tone="success"
        />
      ) : null}
      {props.notice?.status === "phone-code-sent" ? (
        <Banner
          title={t("auth.features.registration.ui.registerPage.phone.code.sent")}
          description={t("auth.features.registration.ui.registerPage.phone.code.ready.check.your.phone")}
          tone="success"
        />
      ) : null}

      <Checkbox
        name="registrationConsentAffirmation"
        value="affirmed"
        checked={consentAffirmed}
        onCheckedChange={(checked) => setConsentAffirmed(checked === true)}
        label={
          <Text as="span" size="sm" weight="medium">
            {t("auth.features.registration.ui.registerPage.consent.affirmation.prefix")}{" "}
            <LinkText href="/terms" target="_blank" rel="noreferrer">
              {t("auth.features.registration.ui.registerPage.consent.terms.of.service")}
            </LinkText>{" "}
            {t("auth.features.registration.ui.registerPage.consent.and")}{" "}
            <LinkText href="/privacy" target="_blank" rel="noreferrer">
              {t("auth.features.registration.ui.registerPage.consent.privacy.policy")}
            </LinkText>
            .
          </Text>
        }
      />

      <Card glow>
        <Stack gap={3}>
          <Inline>
            <Badge tone="accent">{t("auth.features.registration.ui.registerPage.fastest")}</Badge>
            <Text size="sm" tone="secondary">
              {t("auth.features.registration.ui.registerPage.use.an.account.you.already.have")}
            </Text>
          </Inline>
          <Inline>
            <LinkButton
              href={`/api/auth/social/google/start?journey=registration&consentAffirmed=${consentAffirmed}&returnTo=${encodeURIComponent(props.returnTo ?? "/account")}`}
              leadingIcon="badgeCheck"
              block
            >
              {t("auth.features.registration.ui.registerPage.continue.with.google")}
            </LinkButton>
            <LinkButton
              href={`/api/auth/social/facebook/start?journey=registration&consentAffirmed=${consentAffirmed}&returnTo=${encodeURIComponent(props.returnTo ?? "/account")}`}
              leadingIcon="users"
              block
            >
              {t("auth.features.registration.ui.registerPage.continue.with.facebook")}
            </LinkButton>
          </Inline>
        </Stack>
      </Card>

      <SegmentedControl
        fullWidth
        label={t("auth.features.registration.ui.registerPage.method")}
        value={method}
        onValueChange={(value) => selectMethod(value as RegistrationMethod)}
        items={REGISTRATION_METHOD_OPTIONS.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
          icon: option.icon,
        }))}
      />

      {method === "passkey" ? (
        <RegistrationFormCard
          action={props.action}
          formRef={passkeyFormRef}
          glow
          hiddenFields={props.hiddenFields}
          intent="passkey-register"
          method="passkey"
          consentAffirmed={consentAffirmed}
          onSubmit={handlePasskeySubmit}
        >
          <PasskeyHiddenFields payload={passkeyPayload} />
          <Inline>
            <Badge tone="accent">{t("auth.features.registration.ui.registerPage.recommended")}</Badge>
            <Text size="sm" tone="secondary">
              {t("auth.features.registration.ui.registerPage.passkey.recommended.copy")}
            </Text>
          </Inline>
          <IdentityFields details={details} onChange={updateDetails} />
          {passkeyError ? (
            <Banner
              title={t("auth.features.registration.ui.registerPage.passkey.unavailable")}
              description={passkeyError}
              tone="warning"
              role="alert"
              actions={fallbackAction}
            />
          ) : null}
          <Button type="submit" leadingIcon="shield" loading={passkeyLoading}>
            {t("auth.features.registration.ui.registerPage.create.with.passkey")}
          </Button>
        </RegistrationFormCard>
      ) : null}

      {method === "magic-link" ? (
        <RegistrationFormCard
          action={props.action}
          hiddenFields={props.hiddenFields}
          intent="magic-link-register"
          method="magic-link"
          consentAffirmed={consentAffirmed}
          onSubmit={() => handleCompleted("magic-link")}
        >
          <Text size="sm" tone="secondary">
            {t("auth.features.registration.ui.registerPage.magic.link.copy")}
          </Text>
          <IdentityFields details={details} onChange={updateDetails} />
          <Button type="submit" leadingIcon="message">
            {t("auth.features.registration.ui.registerPage.email.me.magic.link")}
          </Button>
        </RegistrationFormCard>
      ) : null}

      {method === "phone-code" ? (
        <>
          <RegistrationFormCard
            action={props.action}
            hiddenFields={props.hiddenFields}
            intent="phone-code-request"
            method="phone-code"
            consentAffirmed={consentAffirmed}
            onSubmit={() => handleCompleted("phone-code")}
          >
            <Text size="sm" tone="secondary">
              {t("auth.features.registration.ui.registerPage.phone.code.copy")}
            </Text>
            <TextInput
              label={t("auth.features.registration.ui.registerPage.display.name")}
              name="displayName"
              autoComplete="name"
              required
              value={details.displayName}
              onChange={(event) => updateDetails("displayName", event.currentTarget.value)}
            />
            <TextInput
              label={t("auth.features.registration.ui.registerPage.phone")}
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              value={details.phone}
              onChange={(event) => updateDetails("phone", event.currentTarget.value)}
            />
            <Button type="submit" leadingIcon="message">
              {t("auth.features.registration.ui.registerPage.text.me.a.code")}
            </Button>
          </RegistrationFormCard>

          <RegistrationFormCard
            action={props.action}
            hiddenFields={props.hiddenFields}
            intent="phone-code-consume"
            method="phone-code"
            consentAffirmed={consentAffirmed}
            onSubmit={() => handleCompleted("phone-code")}
          >
            <Text size="sm" tone="secondary">
              {t("auth.features.registration.ui.registerPage.enter.phone.code.copy")}
            </Text>
            <HiddenInput
              type="hidden"
              name="tokenId"
              value={props.notice?.status === "phone-code-sent" ? props.notice.tokenId : ""}
              readOnly
            />
            <HiddenInput type="hidden" name="displayName" value={details.displayName} readOnly />
            <TextInput
              label={t("auth.features.registration.ui.registerPage.phone")}
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              value={details.phone}
              onChange={(event) => updateDetails("phone", event.currentTarget.value)}
            />
            <TextInput
              label={t("auth.features.registration.ui.registerPage.phone.code.2")}
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              required
              value={details.phoneCode}
              onChange={(event) => updateDetails("phoneCode", event.currentTarget.value)}
            />
            <Button type="submit" leadingIcon="message" tone="secondary">
              {t("auth.features.registration.ui.registerPage.create.account.with.code")}
            </Button>
          </RegistrationFormCard>
        </>
      ) : null}

      {method === "password" ? (
        <RegistrationFormCard
          action={props.action}
          hiddenFields={props.hiddenFields}
          intent="password"
          method="password"
          consentAffirmed={consentAffirmed}
          onSubmit={() => handleCompleted("password")}
        >
          <Text size="sm" tone="secondary">
            {t("auth.features.registration.ui.registerPage.password.fallback.copy")}
          </Text>
          <Divider />
          <IdentityFields details={details} onChange={updateDetails} />
          <PasswordInput
            label={t("auth.features.registration.ui.registerPage.password.2")}
            name="password"
            autoComplete="new-password"
            required
            value={details.password}
            onChange={(event) => updateDetails("password", event.currentTarget.value)}
          />
          <Button type="submit" leadingIcon="lock" tone="secondary">
            {t("auth.features.registration.ui.registerPage.create.account.with.password")}
          </Button>
        </RegistrationFormCard>
      ) : null}
    </Stack>
  );
}
