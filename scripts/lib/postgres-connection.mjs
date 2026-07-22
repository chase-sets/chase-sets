import { readFileSync } from "node:fs";

export function normalizePostgresConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
    if (["prefer", "require", "verify-ca", "no-verify"].includes(sslMode)) {
      url.searchParams.set("sslmode", "verify-full");
    }
    if (url.searchParams.get("sslmode") === "verify-full" && !url.searchParams.has("uselibpqcompat")) {
      url.searchParams.set("uselibpqcompat", "true");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function resolvePostgresSsl(connectionString, env = process.env, read = readFileSync) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return undefined;
  }

  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  if (sslMode === "disable" && isLocalDatabaseHost(url.hostname)) {
    return undefined;
  }
  if (sslMode === "disable") {
    throw new Error("Remote PostgreSQL connections cannot disable TLS verification.");
  }
  if (sslMode === "verify-full" || !isLocalDatabaseHost(url.hostname)) {
    // node-postgres reparses sslmode-bearing URLs after the explicit ssl
    // object, so an environment-only CA is not a reliable trust contract.
    // Managed connections must carry sslrootcert in the URL itself.
    const caPath = url.searchParams.get("sslrootcert");
    const ca = caPath ? read(caPath, "utf8") : undefined;
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  }

  return undefined;
}

export function postgresClientConfig(connectionString, env = process.env, read = readFileSync) {
  const normalizedConnectionString = normalizePostgresConnectionString(connectionString);
  return {
    connectionString: normalizedConnectionString,
    ssl: resolvePostgresSsl(normalizedConnectionString, env, read),
  };
}

export function safeFailureFields(classification, error) {
  const fields = {
    classification:
      typeof classification === "string" && /^[a-z0-9-]{1,80}$/.test(classification)
        ? classification
        : "unclassified-failure",
  };
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
    fields.status = error.status;
  }
  if (typeof error?.code === "string" && /^[A-Z0-9_-]{1,40}$/.test(error.code)) {
    fields.code = error.code;
  }
  return fields;
}

export function postgresFailureFields(error) {
  if (typeof error?.classification === "string") {
    return safeFailureFields(error.classification, error);
  }
  if (
    error?.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    error?.message === "self-signed certificate in certificate chain"
  ) {
    return safeFailureFields("self-signed-certificate-in-certificate-chain", error);
  }
  if (error?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return safeFailureFields("certificate-authority-untrusted", error);
  }
  if (error?.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return safeFailureFields("certificate-hostname-mismatch", error);
  }
  if (error?.code === "ENOENT") {
    return safeFailureFields("certificate-authority-file-unavailable", error);
  }
  return safeFailureFields("postgres-query-failed", error);
}

function isLocalDatabaseHost(hostname) {
  const normalized = String(hostname).toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
