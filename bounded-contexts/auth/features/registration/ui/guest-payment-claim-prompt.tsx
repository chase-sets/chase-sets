import { t } from "@chase-sets/localization";
import { useRef, useState, type FormEvent } from "react";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  Badge,
  Banner,
  Button,
  Divider,
  HiddenInput,
  Inset,
  PageSection,
  ProgressiveDisclosure,
  Stack,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import { createPasskeyCredential, type PasskeyCredentialPayload } from "../../../support/ui-support/passkey-browser";
import type { BoundGuestClaimContact, GuestClaimActionData } from "./guest-payment-claim-contracts";
function PasskeyHiddenFields({ payload }: { payload: PasskeyCredentialPayload | null }) {
  return (
    <>
      <HiddenInput type="hidden" name="challengeId" value={payload?.challengeId ?? ""} readOnly />
      <HiddenInput type="hidden" name="challenge" value={payload?.challenge ?? ""} readOnly />
      <HiddenInput type="hidden" name="externalCredentialId" value={payload?.externalCredentialId ?? ""} readOnly />
      <HiddenInput type="hidden" name="label" value={payload?.label ?? ""} readOnly />
      <HiddenInput type="hidden" name="webauthnResponse" value={payload?.webauthnResponse ?? ""} readOnly />
    </>
  );
}

export function GuestClaimPrompt({
  actionData,
  claimContact,
}: {
  actionData: GuestClaimActionData | undefined;
  claimContact: BoundGuestClaimContact;
}) {
  const [displayName, setDisplayName] = useState(claimContact.contactName);
  const [passkeyPayload, setPasskeyPayload] = useState<PasskeyCredentialPayload | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [isCreatingPasskey, setIsCreatingPasskey] = useState(false);
  const passkeyFormRef = useRef<HTMLFormElement | null>(null);

  async function handlePasskeySubmit(event: FormEvent<HTMLFormElement>) {
    if (passkeyPayload) {
      return;
    }

    event.preventDefault();
    setPasskeyError(null);
    setIsCreatingPasskey(true);

    try {
      const payload = await createPasskeyCredential({
        displayName,
        email: claimContact.contactEmail,
      });
      setPasskeyPayload(payload);
      window.setTimeout(() => passkeyFormRef.current?.requestSubmit(), 0);
    } catch (error) {
      setPasskeyError(
        error instanceof Error
          ? error.message
          : t("auth.routes.marketplace.guestPaymentClaim.passkey.registration.failed"),
      );
    } finally {
      setIsCreatingPasskey(false);
    }
  }

  return (
    <PageSection title={t("auth.routes.marketplace.guestPaymentClaim.save.this.order")}>
      <Surface elevation="elevated" glow>
        <Stack gap={3}>
          <Badge tone="accent">{t("auth.routes.marketplace.guestPaymentClaim.recommended")}</Badge>
          <Text tone="secondary">
            {t("auth.routes.marketplace.guestPaymentClaim.save.this.order.after.payment.with.a.passkey")}
          </Text>
          {actionData && "error" in actionData && actionData.scope === "claim" ? (
            <Banner
              title={t("auth.routes.marketplace.guestPaymentClaim.could.not.save.order")}
              description={actionData.error}
              tone="danger"
            />
          ) : null}
          {actionData && "status" in actionData ? (
            <Banner
              title={t("auth.routes.marketplace.guestPaymentClaim.claim.link.sent.title")}
              description={t("auth.routes.marketplace.guestPaymentClaim.claim.link.sent", {
                email: claimContact.contactEmail,
              })}
              tone="success"
            />
          ) : null}
          {passkeyError ? (
            <Banner
              title={t("auth.routes.marketplace.guestPaymentClaim.passkey.unavailable")}
              description={passkeyError}
              tone="warning"
            />
          ) : null}
          <RouterForm ref={passkeyFormRef} method="post" onSubmit={handlePasskeySubmit} spacing="none">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="claim-passkey" readOnly />
              <HiddenInput type="hidden" name="email" value={claimContact.contactEmail} readOnly />
              <PasskeyHiddenFields payload={passkeyPayload} />
              <TextInput
                label={t("auth.routes.marketplace.guestPaymentClaim.contact.name")}
                name="displayName"
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
              <Inset>
                <Text size="sm" tone="secondary">
                  {t("auth.routes.marketplace.guestPaymentClaim.we.will.save.this.order.to", {
                    email: claimContact.contactEmail,
                  })}
                </Text>
              </Inset>
              <Button type="submit" leadingIcon="shield" loading={isCreatingPasskey}>
                {t("auth.routes.marketplace.guestPaymentClaim.save.with.passkey")}
              </Button>
            </Stack>
          </RouterForm>
          <Divider />
          <RouterForm method="post" spacing="none">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="claim-link-request" readOnly />
              <HiddenInput type="hidden" name="displayName" value={displayName} readOnly />
              <Text size="sm" tone="secondary">
                {t("auth.routes.marketplace.guestPaymentClaim.send.a.claim.link.to", {
                  email: claimContact.contactEmail,
                })}
              </Text>
              <Button type="submit" tone="secondary" leadingIcon="message">
                {t("auth.routes.marketplace.guestPaymentClaim.email.me.a.claim.link")}
              </Button>
            </Stack>
          </RouterForm>
          {actionData && "status" in actionData && actionData.token ? (
            <Inset>
              <RouterForm method="post" spacing="none">
                <Stack gap={2}>
                  <Text size="sm" tone="secondary">
                    {t("auth.routes.marketplace.guestPaymentClaim.local.recovery.token.in.production")}
                  </Text>
                  <HiddenInput type="hidden" name="intent" value="claim-link-consume" readOnly />
                  <HiddenInput type="hidden" name="displayName" value={actionData.displayName} readOnly />
                  <TextInput
                    label={t("auth.routes.marketplace.guestPaymentClaim.claim.token")}
                    name="token"
                    defaultValue={actionData.token}
                    required
                  />
                  <Button type="submit" leadingIcon="message">
                    {t("auth.routes.marketplace.guestPaymentClaim.verify.email.and.save.order")}
                  </Button>
                </Stack>
              </RouterForm>
            </Inset>
          ) : null}
          <ProgressiveDisclosure
            title={t("auth.routes.marketplace.guestPaymentClaim.other.options")}
            summary={t("auth.routes.marketplace.guestPaymentClaim.password.setup.is.available.only.after")}
            tone="info"
          >
            <Text size="sm" tone="secondary">
              {t("auth.routes.marketplace.guestPaymentClaim.password.setup.is.available.only.after")}
            </Text>
          </ProgressiveDisclosure>
        </Stack>
      </Surface>
    </PageSection>
  );
}
