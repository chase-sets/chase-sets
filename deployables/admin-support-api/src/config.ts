import {
  getApiHostContextNames,
  type ApiHostContextName,
} from "@chase-sets/platform-runtime/api";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
import { apiContextRegistry } from "./generated/api-context-registry";

export type AdminSupportApiContextName = ApiHostContextName<typeof apiContextRegistry>;

export type AdminSupportApiPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}>;

export type AdminSupportApiConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  contextDatabaseUrls: Readonly<Partial<Record<AdminSupportApiContextName, string>>>;
  pool: AdminSupportApiPoolConfig;
  port: number;
  internalAuthSecret: string;
  adminRegistrationEnabled: boolean;
  platformAdmin: AdminSupportPlatformAdminConfig | null;
}>;

export type AdminSupportPlatformAdminConfig = Readonly<{
  email: string;
  password: string;
  displayName: string;
  accountName: string;
}>;

const adminSupportContexts = getApiHostContextNames(
  apiContextRegistry,
  "admin-support-api",
);

function getOptionalEnv(name: string) {
  const value = process.env[name];
  return value?.trim() ? value.trim() : null;
}

function getOptionalPositiveNumberEnv(name: string, defaultValue: number) {
  const parsed = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getPositiveNumberEnv(name: string, defaultValue: number) {
  return getOptionalPositiveNumberEnv(name, defaultValue) ?? defaultValue;
}

function getBooleanEnv(name: string, defaultValue: boolean) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function getContextDatabaseEnvName(contextName: AdminSupportApiContextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

function loadPlatformAdminConfig(): AdminSupportPlatformAdminConfig | null {
  const email = getOptionalEnv("PLATFORM_ADMIN_EMAIL");
  const password = getOptionalEnv("PLATFORM_ADMIN_PASSWORD");

  if (!email && !password) {
    return null;
  }

  if (!email || !password) {
    throw new Error(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.",
    );
  }

  return {
    email,
    password,
    displayName: getOptionalEnv("PLATFORM_ADMIN_DISPLAY_NAME") ?? "Platform Admin",
    accountName: getOptionalEnv("PLATFORM_ADMIN_ACCOUNT_NAME") ?? "Chase Sets Platform",
  };
}

export function loadConfig(): AdminSupportApiConfig {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const controlDatabaseUrl =
    getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL") ?? sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error("PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required.");
  }

  const contextDatabaseUrls = Object.fromEntries(
    adminSupportContexts.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));
      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<AdminSupportApiContextName, string>>>;
  const missingContextNames = adminSupportContexts.filter(
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
    pool: {
      max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
      idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
      connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
    },
    port: Number(process.env.PORT ?? 6192),
    internalAuthSecret: resolvePlatformInternalAuthSecret({
      requireExplicitInProduction: true,
    }),
    adminRegistrationEnabled: getBooleanEnv("ADMIN_REGISTRATION_ENABLED", false),
    platformAdmin: loadPlatformAdminConfig(),
  };
}

export { PLATFORM_INTERNAL_AUTH_SECRET_ENV };
