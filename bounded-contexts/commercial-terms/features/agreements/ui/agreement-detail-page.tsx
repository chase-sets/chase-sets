import { t } from "@chase-sets/localization";
import {
  Form,
  Badge,
  Button,
  Card,
  LinkButton,
  NativeSelect,
  NumberInput,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type { CommercialAgreementViewModel } from "./contracts";

function statusTone(status: string) {
  return status === "active" ? "accent" : "warning";
}

export function AgreementDetailPage({
  agreement,
  errorMessage,
}: {
  agreement: CommercialAgreementViewModel;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("commercialTerms.features.agreements.ui.agreementDetailPage.admin")}
        title={agreement.label}
        description={t(
          "commercialTerms.features.agreements.ui.agreementDetailPage.inspect.the.account.specific.commercial.fee",
        )}
        actions={
          <LinkButton href="/identity/commercial-terms/agreements" tone="secondary">
            {t("commercialTerms.features.agreements.ui.agreementDetailPage.back.to.agreements")}
          </LinkButton>
        }
      />
      <PageSection title={t("commercialTerms.features.agreements.ui.agreementDetailPage.agreement")}>
        <Card>
          <Stack gap={2}>
            <Badge tone={statusTone(agreement.status)}>{agreement.status}</Badge>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.agreement.id")}
              {agreement.agreement_id}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.account")}
              {agreement.account_display_name ?? agreement.account_id}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.account.type")}
              {agreement.account_type ?? t("commercialTerms.features.agreements.ui.agreementDetailPage.unknown")}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.marketplace.fee")}
              {agreement.marketplace_sales_fee_percentage_bps}{" "}
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.bps")}
              {agreement.marketplace_sales_fee_fixed_amount}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.shipping.allowance")}
              {agreement.shipping_allowance_percentage_bps}{" "}
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.bps")}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.effective.from")}
              {agreement.effective_from}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.effective.until")}
              {agreement.effective_until ?? t("commercialTerms.features.agreements.ui.agreementDetailPage.open.ended")}
            </Text>
            <Text>
              {t("commercialTerms.features.agreements.ui.agreementDetailPage.updated.at")}
              {agreement.updated_at}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("commercialTerms.features.agreements.ui.agreementDetailPage.revise.agreement")}>
        <Card>
          <Form spacing="none" method="post">
            <Stack gap={3}>
              {errorMessage ? <Text>{errorMessage}</Text> : null}
              <TextInput
                label={t("commercialTerms.features.agreements.ui.agreementDetailPage.label")}
                name="label"
                defaultValue={agreement.label}
                required
              />
              <NumberInput
                label={t("commercialTerms.features.agreements.ui.agreementDetailPage.marketplace.fee.bps")}
                name="marketplaceSalesFeePercentageBps"
                min="0"
                max="10000"
                defaultValue={String(agreement.marketplace_sales_fee_percentage_bps)}
                required
              />
              <TextInput
                label={t("commercialTerms.features.agreements.ui.agreementDetailPage.marketplace.fixed.amount")}
                name="marketplaceSalesFeeFixedAmount"
                inputMode="decimal"
                defaultValue={agreement.marketplace_sales_fee_fixed_amount}
                required
              />
              <NumberInput
                label={t("commercialTerms.features.agreements.ui.agreementDetailPage.shipping.allowance.bps")}
                name="shippingAllowancePercentageBps"
                min="0"
                max="10000"
                defaultValue={String(agreement.shipping_allowance_percentage_bps)}
                required
              />
              <NativeSelect
                label={t("commercialTerms.features.agreements.ui.agreementDetailPage.status")}
                name="status"
                required
                defaultValue={agreement.status}
                items={[
                  { value: "active", label: t("commercialTerms.features.agreements.ui.agreementDetailPage.active") },
                  {
                    value: "inactive",
                    label: t("commercialTerms.features.agreements.ui.agreementDetailPage.inactive"),
                  },
                ]}
              />
              <TextInput
                label={t("commercialTerms.features.agreements.ui.agreementDetailPage.effective.from")}
                name="effectiveFrom"
                defaultValue={agreement.effective_from}
                required
              />
              <TextInput
                label={t("commercialTerms.features.agreements.ui.agreementDetailPage.effective.until")}
                name="effectiveUntil"
                defaultValue={agreement.effective_until ?? ""}
                placeholder={t("commercialTerms.features.agreements.ui.agreementDetailPage.optional.iso.timestamp")}
              />
              <Button type="submit">
                {t("commercialTerms.features.agreements.ui.agreementDetailPage.save.agreement")}
              </Button>
            </Stack>
          </Form>
        </Card>
      </PageSection>
    </Page>
  );
}
