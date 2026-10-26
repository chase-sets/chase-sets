import { useState } from "react";
import { AGENT_OAUTH_KNOWN_SCOPE_FAMILIES } from "@chase-sets/auth-context";
import { Button, Form, Heading, HiddenInput, Inline, List, Stack, Text } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type { AgentOAuthConsent } from "../../../client";

export function AgentConsentPage({
  consent,
  consentToken,
}: {
  consent: AgentOAuthConsent | null;
  consentToken: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  if (!consent) {
    return (
      <Stack gap={3}>
        <Heading level={1}>{t("auth.features.agentGrants.ui.agentConsentPage.invalid.title")}</Heading>
        <Text>{t("auth.features.agentGrants.ui.agentConsentPage.invalid.description")}</Text>
      </Stack>
    );
  }
  const families = AGENT_OAUTH_KNOWN_SCOPE_FAMILIES.map((family) => ({
    family,
    scopes: family.scopes.filter((scope) => consent.scopes.includes(scope.scope)),
  })).filter(({ scopes }) => scopes.length > 0);
  return (
    <Stack gap={4}>
      <Heading level={1}>{t("auth.features.agentGrants.ui.agentConsentPage.title")}</Heading>
      <Stack gap={1}>
        <Text>{t("auth.features.agentGrants.ui.agentConsentPage.client")}</Text>
        <Text weight="semibold">{consent.clientName}</Text>
        <Text tone="secondary">{t("auth.features.agentGrants.ui.agentConsentPage.untrusted.name")}</Text>
        <Text>{t("auth.features.agentGrants.ui.agentConsentPage.redirect")}</Text>
        <Text>{consent.redirectOrigin}</Text>
        <Text>{t("auth.features.agentGrants.ui.agentConsentPage.account")}</Text>
        <Text weight="semibold">{consent.accountName}</Text>
      </Stack>
      <Stack gap={3}>
        <Heading level={2}>{t("auth.features.agentGrants.ui.agentConsentPage.scopes")}</Heading>
        {families.map(({ family, scopes }) => (
          <Stack key={family.family} gap={1}>
            <Text weight="semibold">{family.label}</Text>
            <List items={scopes.map((scope) => `${scope.label} - ${scope.description}`)} />
          </Stack>
        ))}
        {consent.operatorGrantExpiresAt ? (
          <Text>
            {t("auth.features.agentGrants.ui.agentConsentPage.operatorExpiry", {
              date: new Date(consent.operatorGrantExpiresAt).toLocaleDateString(),
            })}
          </Text>
        ) : null}
      </Stack>
      <Inline gap={3}>
        {(["approve", "deny"] as const).map((decision) => (
          <Form
            key={decision}
            method="post"
            action="/ucp/oauth/authorize"
            aria-busy={submitting}
            onSubmit={() => setSubmitting(true)}
          >
            <HiddenInput type="hidden" name="consent_token" value={consentToken} readOnly />
            <HiddenInput type="hidden" name="decision" value={decision} readOnly />
            <Button type="submit" tone={decision === "approve" ? "primary" : "secondary"} disabled={submitting}>
              {decision === "approve"
                ? t("auth.features.agentGrants.ui.agentConsentPage.approve")
                : t("auth.features.agentGrants.ui.agentConsentPage.deny")}
            </Button>
          </Form>
        ))}
      </Inline>
      {consent.memberships
        .filter((membership) => membership.accountId !== consent.accountId)
        .map((membership) => (
          <Form key={membership.accountId} method="post" aria-busy={submitting} onSubmit={() => setSubmitting(true)}>
            <HiddenInput type="hidden" name="consent_token" value={consentToken} readOnly />
            <HiddenInput type="hidden" name="accountId" value={membership.accountId} readOnly />
            <Button type="submit" tone="secondary" disabled={submitting}>
              {t("auth.features.agentGrants.ui.agentConsentPage.switch.account", { account: membership.accountName })}
            </Button>
          </Form>
        ))}
    </Stack>
  );
}
