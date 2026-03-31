export type MarketplaceApiConfig = Readonly<{
  databaseUrl: string;
  identityApiBaseUrl: string;
  port: number;
}>;

export function loadConfig(): MarketplaceApiConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const identityApiBaseUrl =
    process.env.IDENTITY_API_BASE_URL ?? "http://localhost:6181/api/identity";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required.");
  }

  return {
    databaseUrl,
    identityApiBaseUrl,
    port: Number(process.env.PORT ?? 6182),
  };
}
