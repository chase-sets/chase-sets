export function normalizePostgresConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
    if (sslMode === "require" && !url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("uselibpqcompat", "true");
      return url.toString();
    }
  } catch {
    return connectionString;
  }

  return connectionString;
}

export function resolvePostgresSsl(connectionString) {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.get("sslmode")?.toLowerCase() === "require") {
      return { rejectUnauthorized: false };
    }
  } catch {
    return undefined;
  }

  return undefined;
}
