import { useRef, useState, type FormEvent } from "react";
import { t } from "@chase-sets/localization";
import {
  Banner,
  Button,
  Card,
  Form,
  HiddenInput,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { createPasskeyCredential, type PasskeyCredentialPayload } from "../../../support/ui-support/passkey-browser";
import { PasskeyHiddenFields } from "../../../support/ui-support/auth-hidden-fields";
import type { RegistrationConsentResolution } from "../../../support/request-support/registration-consent";
import {
  RegistrationConsentAffirmation,
  RegistrationConsentResolutionInput,
} from "../../registration/ui/registration-consent-affirmation";

export type InvitationAcceptancePresentation =
  | Readonly<{
      status: "pending";
      invitationId: string;
      email: string;
      accountName: string;
      invitedByName: string;
      roleLabel: string;
      requiresRegistration: boolean;
    }>
  | Readonly<{ status: "expired" | "revoked" | "accepted" | "unavailable" }>;

type Props = Readonly<{
  invitation: InvitationAcceptancePresentation;
  token: string;
  action?: string;
  errorMessage?: string | null;
  registrationConsent?: RegistrationConsentResolution | null;
}>;

const terminalCopyKeys = {
  expired: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.expired",
  revoked: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.revoked",
  accepted: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.accepted",
  unavailable: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.unavailable",
} as const;

export function InvitationAcceptancePage({ invitation, token, action, errorMessage, registrationConsent }: Props) {
  const [method, setMethod] = useState<"passkey" | "password">("passkey");
  const [passkeyPayload, setPasskeyPayload] = useState<PasskeyCredentialPayload | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [consentAffirmed, setConsentAffirmed] = useState(false);
  const passkeyForm = useRef<HTMLFormElement | null>(null);

  if (invitation.status !== "pending") {
    return (
      <Card>
        <Stack gap={2}>
          <Text size="lg" weight="semibold">
            {t(terminalCopyKeys[invitation.status])}
          </Text>
          <Text tone="secondary">
            {t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.new.invitation")}
          </Text>
        </Stack>
      </Card>
    );
  }
  const pendingInvitation = invitation;

  async function acceptWithPasskey(event: FormEvent<HTMLFormElement>) {
    if (passkeyPayload) return;
    event.preventDefault();
    setPasskeyError(null);
    setPasskeyLoading(true);
    try {
      setPasskeyPayload(
        await createPasskeyCredential({
          displayName: pendingInvitation.email.split("@")[0] || pendingInvitation.email,
          email: pendingInvitation.email,
        }),
      );
      window.setTimeout(() => passkeyForm.current?.requestSubmit(), 0);
    } catch (error) {
      setPasskeyError(
        error instanceof Error
          ? error.message
          : t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.passkey.failed"),
      );
    } finally {
      setPasskeyLoading(false);
    }
  }

  const commonFields = (
    <>
      <HiddenInput type="hidden" name="invitationId" value={invitation.invitationId} readOnly />
      <HiddenInput type="hidden" name="token" value={token} readOnly />
      {registrationConsent ? <RegistrationConsentResolutionInput resolution={registrationConsent} /> : null}
      <HiddenInput type="hidden" name="consentAffirmed" value={consentAffirmed ? "true" : "false"} readOnly />
    </>
  );

  return (
    <Stack gap={4}>
      <Stack gap={2}>
        <Text size="lg" weight="semibold">
          {t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.accept.invitation")}
        </Text>
        <Text>
          {t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.invited.by", {
            invitedByName: invitation.invitedByName,
            accountName: invitation.accountName,
            roleLabel: invitation.roleLabel,
          })}
        </Text>
      </Stack>
      {errorMessage ? (
        <Banner
          title={t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.acceptance.failed")}
          description={errorMessage}
          tone="danger"
          role="alert"
        />
      ) : null}
      {registrationConsent ? (
        <RegistrationConsentAffirmation
          resolution={registrationConsent}
          affirmed={consentAffirmed}
          onAffirmedChange={setConsentAffirmed}
        />
      ) : null}
      <SegmentedControl
        fullWidth
        label={t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.method")}
        value={method}
        onValueChange={(value) => setMethod(value as "passkey" | "password")}
        items={[
          {
            value: "passkey",
            label: t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.passkey"),
            icon: "shield",
          },
          {
            value: "password",
            label: t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.password"),
            icon: "lock",
          },
        ]}
      />
      {method === "passkey" ? (
        <Card glow>
          <Form ref={passkeyForm} action={action} method="post" onSubmit={acceptWithPasskey}>
            <Stack gap={3}>
              {commonFields}
              <HiddenInput type="hidden" name="credentialMethod" value="passkey" readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <Text tone="secondary">
                {t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.passkey.copy")}
              </Text>
              {passkeyError ? (
                <Banner
                  title={t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.passkey.unavailable")}
                  description={passkeyError}
                  tone="warning"
                  role="alert"
                />
              ) : null}
              <Button type="submit" leadingIcon="shield" loading={passkeyLoading}>
                {t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.accept.passkey")}
              </Button>
            </Stack>
          </Form>
        </Card>
      ) : (
        <Card>
          <Form action={action} method="post">
            <Stack gap={3}>
              {commonFields}
              <HiddenInput type="hidden" name="credentialMethod" value="password" readOnly />
              <PasswordInput
                label={t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.create.password")}
                name="password"
                required
              />
              <Button type="submit" leadingIcon="lock" tone="secondary">
                {t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.accept.password")}
              </Button>
            </Stack>
          </Form>
        </Card>
      )}
    </Stack>
  );
}
