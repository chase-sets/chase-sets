const languageLabelsByCode: Readonly<Record<string, string>> = {
  de: "German",
  en: "English",
  es: "Spanish",
  fr: "French",
  id: "Indonesian",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nl: "Dutch",
  pl: "Polish",
  pt: "Portuguese",
  "pt-br": "Portuguese (Brazil)",
  "pt-pt": "Portuguese (Portugal)",
  ru: "Russian",
  th: "Thai",
  zh: "Chinese",
  "zh-cn": "Chinese (Simplified)",
  "zh-tw": "Chinese (Traditional)",
};

export function sourceOptionDisplayLabel(input: {
  queryKind: string;
  scope: string | null | undefined;
  value: string;
  label: string | null | undefined;
  metadata?: Readonly<Record<string, unknown>> | null;
}): string {
  const value = input.value.trim();
  const label = input.label?.trim() || value;
  if (!isLanguageSourceOption(input.queryKind, input.scope)) {
    return localizedProviderOptionLabel(label, input.metadata);
  }

  const languageLabel = languageLabelsByCode[normalizeLanguageCode(value)];
  if (!languageLabel) {
    return label;
  }

  return normalizeLanguageCode(label) === normalizeLanguageCode(value) ? languageLabel : label;
}

function localizedProviderOptionLabel(
  providerLabel: string,
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): string {
  const platformLabel =
    metadataString(metadata, "platformLabel") ??
    metadataString(metadata, "englishLabel") ??
    metadataString(metadata, "englishName") ??
    localizedLabel(metadata, "en");

  if (!platformLabel || normalizeDisplayLabel(platformLabel) === normalizeDisplayLabel(providerLabel)) {
    return providerLabel;
  }

  return `${platformLabel} (${providerLabel})`;
}

function metadataString(metadata: Readonly<Record<string, unknown>> | null | undefined, key: string): string | null {
  const value = metadata?.[key];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function localizedLabel(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
  languageCode: string,
): string | null {
  const labels = metadata?.localizedLabels;
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return null;
  }
  return metadataString(labels as Readonly<Record<string, unknown>>, languageCode);
}

function isLanguageSourceOption(queryKind: string, scope: string | null | undefined): boolean {
  const normalizedQueryKind = normalizeLanguageCode(queryKind);
  return (
    normalizedQueryKind === "language" ||
    normalizedQueryKind === "languages" ||
    normalizeLanguageCode(scope) === "language"
  );
}

function normalizeLanguageCode(value: string | null | undefined): string {
  return value?.trim().replaceAll("_", "-").toLowerCase() ?? "";
}

function normalizeDisplayLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}
