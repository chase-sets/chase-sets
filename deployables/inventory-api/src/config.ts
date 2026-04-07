export type InventoryApiConfig = Readonly<{
  databaseUrls: Readonly<{
    catalog: string;
    identity: string;
    inventory: string;
    ordering: string;
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

export function loadConfig(): InventoryApiConfig {
  return {
    databaseUrls: {
      catalog: requireEnv("CATALOG_DATABASE_URL"),
      identity: requireEnv("IDENTITY_DATABASE_URL"),
      inventory: requireEnv("INVENTORY_DATABASE_URL"),
      ordering: requireEnv("ORDERING_DATABASE_URL"),
    },
    identityApiBaseUrl: requireEnv("IDENTITY_API_BASE_URL"),
    port: Number(process.env.PORT ?? 6183),
  };
}

