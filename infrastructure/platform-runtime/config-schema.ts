export type PlatformPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}>;

export type PlatformCatalogAssetStorageConfig =
  | Readonly<{
      kind: "filesystem";
      rootDir: string;
      publicBaseUrl: string;
    }>
  | Readonly<{
      kind: "s3";
      bucket: string;
      region: string;
      publicBaseUrl: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    }>;

export type PlatformPaymentProcessorConfig =
  | Readonly<{
      kind: "fake";
    }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      publishableKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      checkoutUiMode?: "elements" | "hosted";
    }>;

export type PlatformMoneyMovementConfig =
  | Readonly<{
      kind: "fake";
    }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
      onboardingReturnUrl?: string;
      onboardingRefreshUrl?: string;
    }>;

export type PlatformPostageConfig<TIncludeWebhookSecret extends boolean = boolean> =
  | Readonly<{
      kind: "sandbox";
    }>
  | (Readonly<{
      kind: "easypost";
      apiKey: string;
      apiBaseUrl?: string;
      mode: "test" | "production";
    }> &
      (TIncludeWebhookSecret extends true
        ? Readonly<{
            webhookSecret?: string;
          }>
        : Readonly<Record<never, never>>));

export type PlatformMobileMessagingProvider = "noop" | "twilio";

export type PlatformDatabaseConfig<TContextName extends string> = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  contextDatabaseUrls: Readonly<Partial<Record<TContextName, string>>>;
}>;

export type PlatformStripeProviderConfig = Readonly<{
  paymentProcessor: PlatformPaymentProcessorConfig;
  moneyMovement: PlatformMoneyMovementConfig;
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  connectWebhookSecret: string | null;
  resolvedConnectWebhookSecret: string | undefined;
  apiBaseUrl: string | undefined;
  checkoutUiMode: string | null;
  connectReturnUrl: string | undefined;
  connectRefreshUrl: string | undefined;
}>;

export function getOptionalEnv(name: string) {
  const value = process.env[name];

  return value?.trim() ? value.trim() : null;
}

export function getBooleanEnv(name: string, defaultValue: boolean) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getOptionalCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getOptionalJsonEnv<T>(name: string): T | null {
  const value = getOptionalEnv(name);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

export function getOptionalPositiveNumberEnv(name: string, defaultValue: number) {
  const parsed = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getPositiveNumberEnv(name: string, defaultValue: number) {
  return getOptionalPositiveNumberEnv(name, defaultValue) ?? defaultValue;
}

export function getRequiredPositiveNumberEnv(name: string, defaultValue: number) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${name} must be a positive number.`);
}

export function getContextDatabaseEnvName(contextName: string) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

export function loadPlatformDatabaseConfig<TContextName extends string>(input: {
  contextNames: readonly TContextName[];
  missingControlDatabaseUrlError: string;
  productionLike?: boolean;
  productionMissingExplicitControlDatabaseUrlError?: string;
}): PlatformDatabaseConfig<TContextName> {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const explicitControlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL");
  const controlDatabaseUrl = explicitControlDatabaseUrl ?? sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error(input.missingControlDatabaseUrlError);
  }
  if (input.productionLike && !explicitControlDatabaseUrl && input.productionMissingExplicitControlDatabaseUrlError) {
    throw new Error(input.productionMissingExplicitControlDatabaseUrlError);
  }

  const contextDatabaseUrls = Object.fromEntries(
    input.contextNames.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));

      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<TContextName, string>>>;
  const missingContextNames = input.contextNames.filter(
    (contextName) => !sharedDatabaseUrl && !contextDatabaseUrls[contextName],
  );

  if (missingContextNames.length > 0) {
    throw new Error(
      `DATABASE_URL or per-context database URLs are required. Missing: ${missingContextNames
        .map((contextName) => getContextDatabaseEnvName(contextName))
        .join(", ")}.`,
    );
  }

  return {
    sharedDatabaseUrl,
    controlDatabaseUrl,
    contextDatabaseUrls,
  };
}

export function loadPoolConfig(): PlatformPoolConfig {
  return {
    max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
    idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
  };
}

export function loadStorageConfig(input: {
  kindEnvName: string;
  localRootEnvName: string;
  publicBaseUrlEnvName: string;
  s3BucketEnvName: string;
  s3RegionEnvName: string;
  s3EndpointEnvName: string;
  s3AccessKeyIdEnvName: string;
  s3SecretAccessKeyEnvName: string;
  s3ForcePathStyleEnvName: string;
  defaultLocalRoot: string;
  defaultPublicBaseUrl: string;
  productionLike: boolean;
  productionFilesystemError: string;
  invalidKindError: string;
  missingS3ConfigError: string;
  mismatchedS3CredentialsError: string;
}): PlatformCatalogAssetStorageConfig {
  const kind = getOptionalEnv(input.kindEnvName) ?? (input.productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (input.productionLike) {
      throw new Error(input.productionFilesystemError);
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv(input.localRootEnvName) ?? input.defaultLocalRoot,
      publicBaseUrl: getOptionalEnv(input.publicBaseUrlEnvName) ?? input.defaultPublicBaseUrl,
    };
  }

  if (kind !== "s3") {
    throw new Error(input.invalidKindError);
  }

  const bucket = getOptionalEnv(input.s3BucketEnvName);
  const region = getOptionalEnv(input.s3RegionEnvName);
  const publicBaseUrl = getOptionalEnv(input.publicBaseUrlEnvName);
  const accessKeyId = getOptionalEnv(input.s3AccessKeyIdEnvName);
  const secretAccessKey = getOptionalEnv(input.s3SecretAccessKeyEnvName);

  if (!bucket || !region || !publicBaseUrl) {
    throw new Error(input.missingS3ConfigError);
  }
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(input.mismatchedS3CredentialsError);
  }

  return {
    kind: "s3",
    bucket,
    region,
    publicBaseUrl,
    endpoint: getOptionalEnv(input.s3EndpointEnvName) ?? undefined,
    accessKeyId: accessKeyId ?? undefined,
    secretAccessKey: secretAccessKey ?? undefined,
    forcePathStyle: getBooleanEnv(input.s3ForcePathStyleEnvName, false),
  };
}

export function loadCatalogAssetStorageConfig(input: {
  port: number;
  productionLike: boolean;
  defaultPublicBaseUrl: string;
}): PlatformCatalogAssetStorageConfig {
  return loadStorageConfig({
    kindEnvName: "CATALOG_ASSET_STORAGE_KIND",
    localRootEnvName: "CATALOG_ASSET_LOCAL_ROOT",
    publicBaseUrlEnvName: "CATALOG_ASSET_PUBLIC_BASE_URL",
    s3BucketEnvName: "CATALOG_ASSET_S3_BUCKET",
    s3RegionEnvName: "CATALOG_ASSET_S3_REGION",
    s3EndpointEnvName: "CATALOG_ASSET_S3_ENDPOINT",
    s3AccessKeyIdEnvName: "CATALOG_ASSET_S3_ACCESS_KEY_ID",
    s3SecretAccessKeyEnvName: "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    s3ForcePathStyleEnvName: "CATALOG_ASSET_S3_FORCE_PATH_STYLE",
    defaultLocalRoot: "artifacts/catalog-assets",
    defaultPublicBaseUrl: input.defaultPublicBaseUrl,
    productionLike: input.productionLike,
    productionFilesystemError: "CATALOG_ASSET_STORAGE_KIND=s3 is required for Catalog asset storage in production.",
    invalidKindError: "CATALOG_ASSET_STORAGE_KIND must be filesystem or s3.",
    missingS3ConfigError:
      "CATALOG_ASSET_S3_BUCKET, CATALOG_ASSET_S3_REGION, and CATALOG_ASSET_PUBLIC_BASE_URL are required when CATALOG_ASSET_STORAGE_KIND=s3.",
    mismatchedS3CredentialsError:
      "CATALOG_ASSET_S3_ACCESS_KEY_ID and CATALOG_ASSET_S3_SECRET_ACCESS_KEY must be configured together.",
  });
}

export function loadStripeProviderConfig(input: {
  productionLike: boolean;
  productionMissingConfigError: string;
}): PlatformStripeProviderConfig {
  const secretKey = getOptionalEnv("STRIPE_SECRET_KEY");
  const publishableKey = getOptionalEnv("STRIPE_PUBLISHABLE_KEY");
  const webhookSecret = getOptionalEnv("STRIPE_WEBHOOK_SECRET");
  const connectWebhookSecret = getOptionalEnv("STRIPE_CONNECT_WEBHOOK_SECRET");
  const apiBaseUrl = getOptionalEnv("STRIPE_API_BASE_URL") ?? undefined;
  const checkoutUiMode = getOptionalEnv("STRIPE_CHECKOUT_UI_MODE");
  const connectReturnUrl = getOptionalEnv("STRIPE_CONNECT_RETURN_URL") ?? undefined;
  const connectRefreshUrl = getOptionalEnv("STRIPE_CONNECT_REFRESH_URL") ?? undefined;
  const resolvedConnectWebhookSecret =
    connectWebhookSecret ?? (!input.productionLike ? (webhookSecret ?? undefined) : undefined);

  if (input.productionLike && (!secretKey || !publishableKey || !webhookSecret || !connectWebhookSecret)) {
    throw new Error(input.productionMissingConfigError);
  }

  return {
    secretKey,
    publishableKey,
    webhookSecret,
    connectWebhookSecret,
    resolvedConnectWebhookSecret,
    apiBaseUrl,
    checkoutUiMode,
    connectReturnUrl,
    connectRefreshUrl,
    paymentProcessor:
      secretKey && publishableKey && webhookSecret
        ? {
            kind: "stripe",
            secretKey,
            publishableKey,
            webhookSecret,
            apiBaseUrl,
            checkoutUiMode: checkoutUiMode === "hosted" ? "hosted" : "elements",
          }
        : { kind: "fake" },
    moneyMovement:
      secretKey && resolvedConnectWebhookSecret
        ? {
            kind: "stripe",
            secretKey,
            webhookSecret: resolvedConnectWebhookSecret,
            apiBaseUrl,
            ...(connectReturnUrl ? { onboardingReturnUrl: connectReturnUrl } : {}),
            ...(connectRefreshUrl ? { onboardingRefreshUrl: connectRefreshUrl } : {}),
          }
        : { kind: "fake" },
  };
}

export function loadPostageConfig<TIncludeWebhookSecret extends boolean>(input: {
  productionLike: boolean;
  productionMissingApiKeyError: string;
  includeWebhookSecret: TIncludeWebhookSecret;
  productionMissingWebhookSecretError?: string;
}): PlatformPostageConfig<TIncludeWebhookSecret> {
  const apiKey = getOptionalEnv("EASYPOST_API_KEY");
  const webhookSecret = input.includeWebhookSecret
    ? (getOptionalEnv("EASYPOST_WEBHOOK_SECRET") ?? undefined)
    : undefined;
  const apiBaseUrl = getOptionalEnv("EASYPOST_API_BASE_URL") ?? undefined;
  const mode = getOptionalEnv("EASYPOST_MODE") === "production" ? "production" : "test";

  if (input.productionLike && !apiKey) {
    throw new Error(input.productionMissingApiKeyError);
  }
  if (input.productionLike && input.includeWebhookSecret && apiKey && !webhookSecret) {
    throw new Error(input.productionMissingWebhookSecretError);
  }
  if (!apiKey) {
    return { kind: "sandbox" };
  }

  return {
    kind: "easypost",
    apiKey,
    ...(input.includeWebhookSecret ? { webhookSecret } : {}),
    apiBaseUrl,
    mode,
  } as PlatformPostageConfig<TIncludeWebhookSecret>;
}

export function resolveMobileMessagingProvider(value: string | null): PlatformMobileMessagingProvider {
  return value === "twilio" ? "twilio" : "noop";
}
