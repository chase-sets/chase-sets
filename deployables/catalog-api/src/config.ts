export type CatalogApiConfig = Readonly<{
  databaseUrl: string;
  port: number;
}>;

export function loadConfig(): CatalogApiConfig {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required.");
  }

  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3100),
  };
}
