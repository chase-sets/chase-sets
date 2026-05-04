import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { CommercialAgreementViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function AgreementDetailPage({ agreement }: { agreement: CommercialAgreementViewModel }) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.agreements.ui.agreementDetailPage.admin")}
        title={agreement.label}
        description={t("commercialTerms.features.agreements.ui.agreementDetailPage.inspect.the.account.specific.commercial.fee")}
        actions={
          <LinkButton href="/commercial-terms/agreements" tone="secondary">
            {t("commercialTerms.features.agreements.ui.agreementDetailPage.back.to.agreements")}</LinkButton>
        }
      />
      <PageSection title={t("commercialTerms.features.agreements.ui.agreementDetailPage.agreement")}>
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(agreement.status)}>{agreement.status}</Badge>
            <Text>{t("commercialTerms.features.agreements.ui.agreementDetailPage.agreement.id")}{agreement.agreement_id}</Text>
            <Text>{t("commercialTerms.features.agreements.ui.agreementDetailPage.account")}{agreement.account_display_name ?? agreement.account_id}</Text>
            <Text>{t("commercialTerms.features.agreements.ui.agreementDetailPage.account.type")}{agreement.account_type ?? t("commercialTerms.features.agreements.ui.agreementDetailPage.unknown")}</Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.marketplace.fee")}{agreement.marketplace_sales_fee_percentage_bps} {t("commercialTerms.features.agreements.ui.agreementDetailPage.bps")}{agreement.marketplace_sales_fee_fixed_amount}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.shipping.allowance")}{agreement.shipping_allowance_percentage_bps} {t("commercialTerms.features.agreements.ui.agreementDetailPage.bps")}
            </Text>
            <Text>{t("commercialTerms.features.agreements.ui.agreementDetailPage.effective.from")}{agreement.effective_from}</Text>
            <Text>{t("commercialTerms.features.agreements.ui.agreementDetailPage.effective.until")}{agreement.effective_until ?? t("commercialTerms.features.agreements.ui.agreementDetailPage.open.ended")}</Text>
            <Text>{t("commercialTerms.features.agreements.ui.agreementDetailPage.updated.at")}{agreement.updated_at}</Text>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
