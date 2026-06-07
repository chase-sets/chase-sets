import type { PostagePolicyCommandRequest, PostagePolicyPreviewRequest } from "./contracts";

function formStrings(formData: FormData, name: string) {
  return formData.getAll(name).map((entry) => String(entry));
}

function formNumber(formData: FormData, name: string) {
  return Number(formData.get(name) ?? 0);
}

function formNullableNumber(formData: FormData, name: string) {
  const value = String(formData.get(name) ?? "").trim();
  return value.length === 0 ? null : Number(value);
}

export function postagePolicyRequestFromForm(formData: FormData): PostagePolicyCommandRequest {
  return {
    label: String(formData.get("label") ?? ""),
    effectiveFrom: String(formData.get("effectiveFrom") ?? ""),
    effectiveUntil: String(formData.get("effectiveUntil") ?? ""),
    policyVersion: String(formData.get("policyVersion") ?? ""),
    maxLetterUnits: formNumber(formData, "maxLetterUnits"),
    maxLetterWeightOunces: formNumber(formData, "maxLetterWeightOunces"),
    maxLetterThicknessInches: formNumber(formData, "maxLetterThicknessInches"),
    maxLetterDeclaredValueAmount: formNumber(formData, "maxLetterDeclaredValueAmount"),
    letterEnvelopeWeightOunces: formNumber(formData, "letterEnvelopeWeightOunces"),
    parcelPackagingWeightOunces: formNumber(formData, "parcelPackagingWeightOunces"),
    parcelRequiredShippingOptions: formStrings(formData, "parcelRequiredShippingOptions") as never,
    letterRequiredPhysicalFlags: formStrings(formData, "letterRequiredPhysicalFlags") as never,
    parcelRequiredPhysicalFlags: formStrings(formData, "parcelRequiredPhysicalFlags") as never,
    signatureRequiredShippingOptions: formStrings(formData, "signatureRequiredShippingOptions") as never,
    signatureRequiredDeclaredValueAmount: formNullableNumber(formData, "signatureRequiredDeclaredValueAmount"),
    signatureRequiredPhysicalFlags: formStrings(formData, "signatureRequiredPhysicalFlags") as never,
  };
}

export function postagePolicyPreviewRequestFromForm(formData: FormData): PostagePolicyPreviewRequest {
  return {
    policy: postagePolicyRequestFromForm(formData),
    shippingOption: String(formData.get("previewShippingOption") ?? "standard") as never,
    itemSubtotalAmount: String(formData.get("previewItemSubtotalAmount") ?? "0"),
    quantity: formNumber(formData, "previewQuantity"),
    unitLengthInches: formNumber(formData, "previewUnitLengthInches"),
    unitWidthInches: formNumber(formData, "previewUnitWidthInches"),
    unitHeightInches: formNumber(formData, "previewUnitHeightInches"),
    unitWeightOunces: formNumber(formData, "previewUnitWeightOunces"),
    physicalFlags: formStrings(formData, "previewPhysicalFlags") as never,
  };
}
