export type IdentityApiConfig = Readonly<{
  databaseUrls: Readonly<{
    auth: string;
    identity: string;
  }>;
  port: number;
}>;

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }

  return value;
}

export function loadConfig(): IdentityApiConfig {
  return {
    databaseUrls: {
      auth: requireEnv("AUTH_DATABASE_URL"),
      identity: requireEnv("IDENTITY_DATABASE_URL"),
    },
    port: Number(process.env.PORT ?? 6181),
  };
}
