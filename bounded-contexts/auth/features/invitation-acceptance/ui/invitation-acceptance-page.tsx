import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { t } from "@chase-sets/localization";
import {
  Banner,
  Button,
  Card,
  Form,
  HiddenInput,
  LinkButton,
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
    attemptsActive?: boolean;
    attemptId?: string | null;
    phase?:
      | "editing"
      | "submitting"
      | "confirming"
      | "succeeded"
      | "accepted-reauth-required"
      | "failed-safe"
      | "conflict"
      | "ambiguous"
      | "route-denied";
    submit?: (form: HTMLFormElement) => void;
    invitationId?: string;
  }>;

const terminalCopyKeys = {
  expired: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.expired",
  revoked: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.revoked",
  accepted: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.accepted",
  unavailable: "auth.features.invitationAcceptance.ui.invitationAcceptancePage.invitation.unavailable",
} as const;

export function InvitationAcceptancePage(props: Props) {
  const {
    invitation,
    token,
    action,
    attemptsActive = false,
    attemptId,
    phase = "editing",
    submit,
    invitationId,
  } = props;
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
  const submissionId = useRef(attemptId ?? "");
  const submitting = useRef(false);
  const [retainedAttempt, setRetainedAttempt] = useState<string | null>(null);
  const retainedInvitationId = invitationId ?? (invitation.status === "pending" ? invitation.invitationId : "");
  useEffect(() => {
    try {
      const retained: unknown = window.history.state?.invitationAcceptanceAttempt;
      if (
        retained &&
        typeof retained === "object" &&
        Object.keys(retained).length === 2 &&
        "invitationId" in retained &&
        retained.invitationId === retainedInvitationId &&
        "attemptId" in retained &&
        typeof retained.attemptId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retained.attemptId)
      ) {
        submissionId.current = retained.attemptId;
        setRetainedAttempt(retained.attemptId);
      }
    } catch {
      /* History denial does not authorize a write retry. */
    }
  }, [retainedInvitationId]);
  const effectivePhase = retainedAttempt && phase === "editing" ? "confirming" : phase;
  const effectiveAttemptId = attemptId ?? retainedAttempt;
  useEffect(() => {
    if (!props.submissionPending && (phase === "editing" || phase === "failed-safe")) submitting.current = false;
  }, [phase, props.submissionPending]);
  useEffect(() => {
    if (effectivePhase !== "editing") document.getElementById("invitation-acceptance-status")?.focus();
  }, [effectivePhase]);

  function submitOnce(event: FormEvent<HTMLFormElement>) {
    if (submitting.current) {
      event.preventDefault();
      return;
    }
    if (attemptsActive) {
      submissionId.current ||= crypto.randomUUID();
      const field = event.currentTarget.elements.namedItem("attemptId");
      if (field instanceof HTMLInputElement) field.value = submissionId.current;
      try {
        window.history.replaceState(
          {
            ...window.history.state,
            invitationAcceptanceAttempt: { invitationId: retainedInvitationId, attemptId: submissionId.current },
          },
          "",
        );
      } catch {
        /* The in-memory UUID still binds this submission. */
      }
    }
    submitting.current = true;
    feedback.begin();
    setPasskeyError(null);
    if (submit) {
      event.preventDefault();
      submit(event.currentTarget);
    } else {
      props.onSubmit?.(event);
    }
  }

  if (effectivePhase !== "editing" && effectivePhase !== "failed-safe") {
    const accepted = effectivePhase === "accepted-reauth-required" || effectivePhase === "succeeded";
    return (
      <Stack gap={3}>
        <Banner
          id="invitation-acceptance-status"
          tabIndex={-1}
          role="status"
          aria-live="polite"
          tone={accepted ? "success" : "warning"}
          title={t(`auth.invitationAttempt.${effectivePhase}`)}
          description={t("auth.invitationAttempt.safeRecovery")}
        />
        <LinkButton href="/sign-in">{t("auth.invitationAttempt.signIn")}</LinkButton>
        {effectiveAttemptId && effectivePhase !== "submitting" ? (
          <Form
            action={action}
            method="post"
            onSubmit={(event) => {
              if (submit) {
                event.preventDefault();
                submit(event.currentTarget);
              }
            }}
          >
            <HiddenInput name="intent" value="status" readOnly />
            <HiddenInput name="attemptId" value={effectiveAttemptId} readOnly />
            <HiddenInput
              name="invitationId"
              value={invitationId ?? (invitation.status === "pending" ? invitation.invitationId : "")}
              readOnly
            />
            {!submit ? <HiddenInput name="token" value={token} readOnly /> : null}
            <Button type="submit">{t("auth.invitationAttempt.checkStatus")}</Button>
          </Form>
        ) : null}
      </Stack>
    );
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
      submitOnce(event);
      return;
    }
    event.preventDefault();
    if (passkeyLoading) return;
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
      {!submit ? <HiddenInput type="hidden" name="token" value={token} readOnly /> : null}
      {attemptsActive ? <HiddenInput type="hidden" name="attemptId" defaultValue={submissionId.current} /> : null}
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
      {effectivePhase === "failed-safe" ? (
        <Banner
          id="invitation-acceptance-status"
          tabIndex={-1}
          aria-live="polite"
          title={t("auth.features.invitationAcceptance.ui.invitationAcceptancePage.acceptance.failed")}
          description={t("auth.invitationAttempt.failed-safe")}
          tone="danger"
          role="status"
        />
      ) : null}
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
          <Form action={action} method="post" onSubmit={submitOnce}>
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
