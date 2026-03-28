export type CatalogApiConfig = Readonly<{
  databaseUrl: string;
  identityApiBaseUrl: string;
  port: number;
}>;

export function loadConfig(): CatalogApiConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const identityApiBaseUrl = process.env.IDENTITY_API_BASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required.");
  }

  if (!identityApiBaseUrl) {
    throw new Error("IDENTITY_API_BASE_URL environment variable is required.");
  }

  return {
    databaseUrl,
    identityApiBaseUrl,
    port: Number(process.env.PORT ?? 3100),
  };
}
