import { Checkbox, NumberInput, PageSection, Stack, TextInput } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { defaultPostagePolicy, type PostagePolicy } from "@chase-sets/product-measures";

export const postagePolicyShippingOptions = [
  { value: "standard", label: t("ordering.features.postagePolicies.ui.form.standard") },
  { value: "expedited", label: t("ordering.features.postagePolicies.ui.form.expedited") },
  { value: "priority", label: t("ordering.features.postagePolicies.ui.form.priority") },
] as const;

export const postagePolicyPhysicalFlags = [
  { value: "raw-card", label: t("ordering.features.postagePolicies.ui.form.raw.card") },
  { value: "slab", label: t("ordering.features.postagePolicies.ui.form.slab") },
  { value: "sealed", label: t("ordering.features.postagePolicies.ui.form.sealed") },
  { value: "rigid", label: t("ordering.features.postagePolicies.ui.form.rigid") },
  { value: "bendable", label: t("ordering.features.postagePolicies.ui.form.bendable") },
  { value: "metal", label: t("ordering.features.postagePolicies.ui.form.metal") },
  { value: "jumbo", label: t("ordering.features.postagePolicies.ui.form.jumbo") },
  { value: "irregular", label: t("ordering.features.postagePolicies.ui.form.irregular") },
] as const;

function checkboxList({
  name,
  items,
  selected,
}: {
  name: string;
  items: readonly { value: string; label: string }[];
  selected: readonly string[];
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <Checkbox
          key={item.value}
          name={name}
          value={item.value}
          label={item.label}
          defaultChecked={selected.includes(item.value)}
        />
      ))}
    </div>
  );
}

export function PostagePolicyFormFields({ policy = defaultPostagePolicy }: { policy?: PostagePolicy }) {
  return (
    <Stack gap={4}>
      <TextInput
        label={t("ordering.features.postagePolicies.ui.form.policy.version")}
        name="policyVersion"
        defaultValue={policy.policyVersion}
        required
      />
      <div className="grid gap-3 md:grid-cols-2">
        <NumberInput
          label={t("ordering.features.postagePolicies.ui.form.max.letter.units")}
          name="maxLetterUnits"
          min="1"
          defaultValue={String(policy.maxLetterUnits)}
          required
        />
        <NumberInput
          label={t("ordering.features.postagePolicies.ui.form.max.letter.weight.oz")}
          name="maxLetterWeightOunces"
          min="0.01"
          step="0.01"
          defaultValue={String(policy.maxLetterWeightOunces)}
          required
        />
        <NumberInput
          label={t("ordering.features.postagePolicies.ui.form.max.letter.thickness.in")}
          name="maxLetterThicknessInches"
          min="0.01"
          step="0.001"
          defaultValue={String(policy.maxLetterThicknessInches)}
          required
        />
        <NumberInput
          label={t("ordering.features.postagePolicies.ui.form.max.letter.declared.value")}
          name="maxLetterDeclaredValueAmount"
          min="0"
          step="0.01"
          defaultValue={String(policy.maxLetterDeclaredValueAmount)}
          required
        />
        <NumberInput
          label={t("ordering.features.postagePolicies.ui.form.letter.envelope.weight.oz")}
          name="letterEnvelopeWeightOunces"
          min="0"
          step="0.01"
          defaultValue={String(policy.letterEnvelopeWeightOunces)}
          required
        />
        <NumberInput
          label={t("ordering.features.postagePolicies.ui.form.parcel.packaging.weight.oz")}
          name="parcelPackagingWeightOunces"
          min="0"
          step="0.01"
          defaultValue={String(policy.parcelPackagingWeightOunces)}
          required
        />
        <NumberInput
          label={t("ordering.features.postagePolicies.ui.form.signature.declared.value")}
          name="signatureRequiredDeclaredValueAmount"
          min="0"
          step="0.01"
          defaultValue={
            policy.signatureRequiredDeclaredValueAmount == null
              ? ""
              : String(policy.signatureRequiredDeclaredValueAmount)
          }
        />
      </div>

      <PageSection title={t("ordering.features.postagePolicies.ui.form.parcel.requirements")}>
        <Stack gap={3}>
          {checkboxList({
            name: "parcelRequiredShippingOptions",
            items: postagePolicyShippingOptions,
            selected: policy.parcelRequiredShippingOptions,
          })}
          {checkboxList({
            name: "parcelRequiredPhysicalFlags",
            items: postagePolicyPhysicalFlags,
            selected: policy.parcelRequiredPhysicalFlags,
          })}
        </Stack>
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.form.letter.eligibility")}>
        {checkboxList({
          name: "letterRequiredPhysicalFlags",
          items: postagePolicyPhysicalFlags,
          selected: policy.letterRequiredPhysicalFlags,
        })}
      </PageSection>

      <PageSection title={t("ordering.features.postagePolicies.ui.form.signature.requirements")}>
        <Stack gap={3}>
          {checkboxList({
            name: "signatureRequiredShippingOptions",
            items: postagePolicyShippingOptions,
            selected: policy.signatureRequiredShippingOptions,
          })}
          {checkboxList({
            name: "signatureRequiredPhysicalFlags",
            items: postagePolicyPhysicalFlags,
            selected: policy.signatureRequiredPhysicalFlags,
          })}
        </Stack>
      </PageSection>
    </Stack>
  );
}
