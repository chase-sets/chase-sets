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
}): string {
  const value = input.value.trim();
  const label = input.label?.trim() || value;
  if (!isLanguageSourceOption(input.queryKind, input.scope)) {
    return label;
  }

  const languageLabel = languageLabelsByCode[normalizeLanguageCode(value)];
  if (!languageLabel) {
    return label;
  }

  return normalizeLanguageCode(label) === normalizeLanguageCode(value) ? languageLabel : label;
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
