import { t } from "@chase-sets/localization";
import { Button, HiddenInput, NativeSelect, NumberField, Stack, TextInput } from "@chase-sets/design-system";

export function AgreementCreateFields({ accountId }: { accountId?: string }) {
  return (
    <Stack gap={3}>
      <TextInput label={t("commercialTerms.features.agreements.ui.agreementListPage.label")} name="label" required />
      {accountId ? (
        <HiddenInput name="accountId" value={accountId} />
      ) : (
        <TextInput
          label={t("commercialTerms.features.agreements.ui.agreementListPage.account.id")}
          name="accountId"
          description={t("commercialTerms.features.agreements.ui.agreementListPage.account.id.description")}
          pattern="acc_.*"
          placeholder={t("commercialTerms.features.agreements.ui.agreementListPage.account.id.placeholder")}
          title={t("commercialTerms.features.agreements.ui.agreementListPage.account.id.validation")}
          autoComplete="off"
          spellCheck={false}
          required
        />
      )}
      <NumberField
        label={t("commercialTerms.features.agreements.ui.agreementListPage.marketplace.fee.bps")}
        name="marketplaceSalesFeePercentageBps"
        min={0}
        max={10000}
        defaultValue={700}
        required
      />
      <TextInput
        label={t("commercialTerms.features.agreements.ui.agreementListPage.marketplace.fixed.amount")}
        name="marketplaceSalesFeeFixedAmount"
        inputMode="decimal"
        defaultValue="0.05"
        required
      />
      <NumberField
        label={t("commercialTerms.features.agreements.ui.agreementListPage.shipping.allowance.bps")}
        name="shippingAllowancePercentageBps"
        min={0}
        max={10000}
        defaultValue={500}
        required
      />
      <NativeSelect
        label={t("commercialTerms.features.agreements.ui.agreementListPage.status")}
        name="status"
        required
        defaultValue="active"
        items={[
          { value: "active", label: t("commercialTerms.features.agreements.ui.agreementListPage.active") },
          { value: "inactive", label: t("commercialTerms.features.agreements.ui.agreementListPage.inactive") },
        ]}
      />
      <TextInput
        label={t("commercialTerms.features.agreements.ui.agreementListPage.effective.from")}
        name="effectiveFrom"
        defaultValue={new Date().toISOString()}
        required
      />
      <TextInput
        label={t("commercialTerms.features.agreements.ui.agreementListPage.effective.until")}
        name="effectiveUntil"
        placeholder={t("commercialTerms.features.agreements.ui.agreementListPage.optional.iso.timestamp")}
      />
      <Button type="submit">{t("commercialTerms.features.agreements.ui.agreementListPage.create.agreement.2")}</Button>
    </Stack>
  );
}
