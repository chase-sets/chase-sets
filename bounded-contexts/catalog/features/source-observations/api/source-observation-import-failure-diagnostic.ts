export type SourceObservationImportFailureDiagnostic = Readonly<{
  code: "source-observation-normalization-failed" | "provider-import-failed";
  fieldPath: string | null;
}>;

const scrydexNormalizationPrefix = "Catalog provider 'scrydex' source observation normalization failed at ";
const observationField =
  /^(sourceObservation\.(?:observationId|externalKey|sourceUrl|sourceUpdatedAt|sourcePayload)|normalizedObservation\.(?:languageCode|fields\.(?:name|cardNumber|setId|setCode|setName|imageUrls|tcg|sealedProductForm|mergeIdentity|externalCatalogItemReferences|externalProductReferences)))(?:\.[\w.]+)?$/;

export function sourceObservationImportFailureDiagnostic(
  providerKey: string,
  reason: string | null,
): SourceObservationImportFailureDiagnostic {
  // Stored outcomes have message text, not the thrown error. Keep only the
  // fixed field root, never interpreter suffixes or provider-supplied detail.
  if (providerKey === "scrydex" && reason?.startsWith(scrydexNormalizationPrefix)) {
    const fields = reason.slice(scrydexNormalizationPrefix.length).split(": ", 1)[0]!.replace(/\.$/, "");
    for (const path of fields.split(", ")) {
      const fieldPath = observationField.exec(path)?.[1];
      if (fieldPath) return { code: "source-observation-normalization-failed", fieldPath };
    }
  }
  return { code: "provider-import-failed", fieldPath: null };
}
