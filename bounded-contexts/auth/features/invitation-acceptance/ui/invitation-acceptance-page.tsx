import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
  ValidationSummary,
} from "@chase-sets/design-system";
import { createPasskeyCredential, type PasskeyCredentialPayload } from "../../../support/ui-support/passkey-browser";
import { PasskeyHiddenFields } from "../../../support/ui-support/auth-hidden-fields";
import {
  authFormErrors,
  useAuthFormFeedback,
  type AuthFormFeedbackProps,
} from "../../../support/ui-support/auth-form-feedback";

export type InvitationAcceptancePresentation =
  | Readonly<{
      status: "pending";
      invitationId: string;
      email: string;
      accountName: string;
      invitedByName: string;
      roleLabel: string;
    }>
  | Readonly<{ status: "expired" | "revoked" | "accepted" | "unavailable" }>;

type Props = AuthFormFeedbackProps &
  Readonly<{
    invitation: InvitationAcceptancePresentation;
    token: string;
    action?: string;
  }>;

const terminalCopyKeys = {
  expired: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.expired",
  revoked: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.revoked",
  accepted: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.accepted",
  unavailable: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.unavailable",
} as const;

export function InvitationAcceptancePage(props: Props) {
  const { invitation, token, action } = props;
  const [method, setMethod] = useState<"passkey" | "password">("passkey");
  const [passkeyPayload, setPasskeyPayload] = useState<PasskeyCredentialPayload | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const passkeyForm = useRef<HTMLFormElement | null>(null);
  const warningId = useId();
  const feedback = useAuthFormFeedback(props);
  const { summary } = authFormErrors(feedback.error);

  useEffect(() => {
    if (passkeyError) document.getElementById(warningId)?.focus();
  }, [passkeyError, warningId]);

  function handleServerSubmit(event: FormEvent<HTMLFormElement>) {
    feedback.begin();
    setPasskeyError(null);
    props.onSubmit?.(event);
  }

  if (invitation.status !== "pending") {
    return (
      <Card elevation="tinted">
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
      const payload = await createPasskeyCredential({
        displayName: pendingInvitation.email.split("@")[0] || pendingInvitation.email,
        email: pendingInvitation.email,
      });
      if (passkeyForm.current !== form) return;
      setPasskeyPayload(payload);
      window.setTimeout(() => {
        if (passkeyForm.current === form) form.requestSubmit();
      }, 0);
    } catch {
      if (passkeyForm.current === form)
        setPasskeyError(t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.passkey.failed"));
    } finally {
      if (passkeyForm.current === form) setPasskeyLoading(false);
    }
  }

  const commonFields = (
    <>
      <HiddenInput type="hidden" name="invitationId" value={invitation.invitationId} readOnly />
      <HiddenInput type="hidden" name="token" value={token} readOnly />
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
      <ValidationSummary
        ref={feedback.summaryRef}
        title={t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.acceptance.failed")}
        errors={summary}
      />
      <SegmentedControl
        fullWidth
        label={t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.method")}
        value={method}
        onValueChange={(value) => {
          feedback.clear();
          setPasskeyError(null);
          setPasskeyPayload(null);
          setPasskeyLoading(false);
          setMethod(value as "passkey" | "password");
        }}
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
        <Card key="passkey" elevation="elevated" glow>
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
                  id={warningId}
                  tabIndex={-1}
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
        <Card key="password" elevation="elevated">
          <Form action={action} method="post" onSubmit={handleServerSubmit}>
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
