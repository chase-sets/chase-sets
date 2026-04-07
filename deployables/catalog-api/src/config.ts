export type CatalogApiConfig = Readonly<{
  databaseUrls: Readonly<{
    catalog: string;
  }>;
  identityApiBaseUrl: string;
  port: number;
}>;

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }

  return value;
}

export function loadConfig(): CatalogApiConfig {
  return {
    databaseUrls: {
      catalog: requireEnv("CATALOG_DATABASE_URL"),
    },
    identityApiBaseUrl: requireEnv("IDENTITY_API_BASE_URL"),
    port: Number(process.env.PORT ?? 6180),
  };
}
