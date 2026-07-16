import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Form,
  HiddenInput,
  Inline,
  LiveRegion,
  ModalDialog,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { Consent } from "./contracts";
import { CustomerSummaryPage } from "../../../support/ui-support/customer-pages";

export function ConsentHistoryPage({
  consents,
  errorMessage,
}: {
  consents: readonly Consent[];
  errorMessage?: string | null;
}) {
  return (
    <Stack gap={3}>
      {errorMessage ? (
        <LiveRegion>
          <Text>{errorMessage}</Text>
        </LiveRegion>
      ) : null}
      <CustomerSummaryPage
        title={t("identity.features.consents.ui.consentHistoryPage.consent.history")}
        description={t("identity.features.consents.ui.consentHistoryPage.audit.history.for.agreements.policies.and")}
        sections={consents.map((consent) => ({
          key: consent.consent_id,
          title: t("identity.features.consents.ui.consentHistoryPage.policy.title", {
            policyKey: consent.policy_key,
            policyVersion: consent.policy_version,
          }),
          body:
            consent.status === "withdrawn"
              ? t("identity.features.consents.ui.consentHistoryPage.withdrawn.at", {
                  recordedAt: consent.recorded_at,
                  withdrawnAt: consent.withdrawn_at ?? consent.updated_at,
                })
              : t("identity.features.consents.ui.consentHistoryPage.recorded.at", {
                  recordedAt: consent.recorded_at,
                }),
          action: (
            <Inline gap={2}>
              <Badge tone={consent.status === "withdrawn" ? "neutral" : "success"}>
                {consent.status === "withdrawn"
                  ? t("identity.features.consents.ui.consentHistoryPage.withdrawn")
                  : t("identity.features.consents.ui.consentHistoryPage.recorded")}
              </Badge>
              {consent.status === "recorded" && consent.is_current ? (
                <ModalDialog
                  title={t("identity.features.consents.ui.consentHistoryPage.withdraw.confirm.title", {
                    policyKey: consent.policy_key,
                  })}
                  description={t("identity.features.consents.ui.consentHistoryPage.withdraw.confirm.description", {
                    policyKey: consent.policy_key,
                  })}
                  trigger={
                    <Button type="button" tone="danger">
                      {t("identity.features.consents.ui.consentHistoryPage.withdraw")}
                    </Button>
                  }
                >
                  <Form spacing="none" method="post">
                    <HiddenInput type="hidden" name="intent" value="withdraw" readOnly />
                    <HiddenInput type="hidden" name="consentId" value={consent.consent_id} readOnly />
                    <Button type="submit" tone="danger">
                      {t("identity.features.consents.ui.consentHistoryPage.withdraw.confirm.action")}
                    </Button>
                  </Form>
                </ModalDialog>
              ) : null}
            </Inline>
          ),
        }))}
      />
    </Stack>
  );
}
