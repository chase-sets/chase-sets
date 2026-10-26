export type GoogleMerchantConfig =
  | Readonly<{
      syncEnabled: false;
      dryRun: boolean;
    }>
  | Readonly<{
      syncEnabled: true;
      dryRun: boolean;
      merchantAccountId: string;
      apiDataSourceId: string;
      targetCountry: string;
      contentLanguage: string;
      feedLabel: string;
      credentialSecretName: string;
      productionSyncApprovalReference: string | null;
    }>;

export function describeGoogleMerchantConfigForLogs(config: GoogleMerchantConfig) {
  if (!config.syncEnabled) {
    return { syncEnabled: false, dryRun: config.dryRun };
  }

  return {
    syncEnabled: true,
    dryRun: config.dryRun,
    merchantAccountId: config.merchantAccountId,
    apiDataSourceId: config.apiDataSourceId,
    targetCountry: config.targetCountry,
    contentLanguage: config.contentLanguage,
    feedLabel: config.feedLabel,
    credentialSecretName: "[configured]",
    productionSyncApprovalReference: config.productionSyncApprovalReference,
  };
}

const PLACEHOLDER_PRODUCTION_SYNC_APPROVAL_REFERENCE_PATTERN =
  /^(?:tbd|todo|none|null|n\/a|na|placeholder|example|sample|test|ticket|record|launch-000)$/i;

function isValidProductionSyncApprovalReference(value: string): boolean {
  const normalized = value.trim();
  return normalized.length >= 6 && !PLACEHOLDER_PRODUCTION_SYNC_APPROVAL_REFERENCE_PATTERN.test(normalized);
}

export function loadGoogleMerchantConfig(input: {
  syncEnabled: boolean;
  dryRun: boolean;
  merchantAccountId: string | null;
  apiDataSourceId: string | null;
  targetCountry: string;
  contentLanguage: string;
  feedLabel: string;
  credentialSecretName: string | null;
  productionSyncApprovalReference: string | null;
}): GoogleMerchantConfig {
  if (!input.syncEnabled) return { syncEnabled: false, dryRun: input.dryRun };

  const missing = [
    ["GOOGLE_MERCHANT_ACCOUNT_ID", input.merchantAccountId],
    ["GOOGLE_MERCHANT_API_DATA_SOURCE_ID", input.apiDataSourceId],
    ["GOOGLE_MERCHANT_TARGET_COUNTRY", input.targetCountry],
    ["GOOGLE_MERCHANT_CONTENT_LANGUAGE", input.contentLanguage],
    ["GOOGLE_MERCHANT_FEED_LABEL", input.feedLabel],
    ["GOOGLE_MERCHANT_CREDENTIAL_SECRET_NAME", input.credentialSecretName],
  ].flatMap(([name, value]) => (value ? [] : [name]));

  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} are required when GOOGLE_MERCHANT_SYNC_ENABLED=true.`);
  }
  if (!/^[A-Z]{2}$/.test(input.targetCountry)) {
    throw new Error("GOOGLE_MERCHANT_TARGET_COUNTRY must be an ISO 3166-1 alpha-2 country code such as US.");
  }
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(input.contentLanguage)) {
    throw new Error("GOOGLE_MERCHANT_CONTENT_LANGUAGE must be a language code such as en or en-US.");
  }

  const productionSyncApprovalReference = input.productionSyncApprovalReference?.trim() || null;
  if (productionSyncApprovalReference && !isValidProductionSyncApprovalReference(productionSyncApprovalReference)) {
    throw new Error(
      "GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE must point to a real external evidence record, not a placeholder.",
    );
  }
  if (!input.dryRun && !productionSyncApprovalReference) {
    throw new Error(
      "GOOGLE_MERCHANT_PRODUCTION_SYNC_APPROVAL_REFERENCE is required when GOOGLE_MERCHANT_DRY_RUN=false. Run `pnpm run ops google-shopping:launch-readiness-evidence -- --expected-mode live` and record the passing evidence reference before enabling live Merchant writes.",
    );
  }

  return {
    syncEnabled: true,
    dryRun: input.dryRun,
    merchantAccountId: input.merchantAccountId as string,
    apiDataSourceId: input.apiDataSourceId as string,
    targetCountry: input.targetCountry,
    contentLanguage: input.contentLanguage,
    feedLabel: input.feedLabel,
    credentialSecretName: input.credentialSecretName as string,
    productionSyncApprovalReference,
  };
}
