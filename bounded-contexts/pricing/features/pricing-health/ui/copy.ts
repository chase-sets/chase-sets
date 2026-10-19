import { formatMachineValue, t, type TranslationValues } from "@chase-sets/localization";

export const healthCopy = (key: string, values?: TranslationValues) =>
  t(`pricing.features.pricingHealth.${key}`, values);
export const healthReasonLabel = (value: string) =>
  formatMachineValue(value, {
    knownValueTranslationKeys: {},
    family: healthCopy("reason"),
    translate: t,
    unrecognizedTranslationKey: "pricing.features.pricingHealth.reason.unknown",
    unrecognizedWithValueTranslationKey: "pricing.features.pricingHealth.reason.value",
  });
export const healthNumber = (value: number | null) =>
  value === null
    ? healthCopy("unavailable")
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
export const healthPercent = (value: number | null) =>
  value === null
    ? healthCopy("unavailable")
    : new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2 }).format(value);
