import { describe, expect, it } from "vitest";
import {
  normalizePostgresConnectionString,
  postgresClientConfig,
  postgresFailureFields,
  resolvePostgresSsl,
  safeFailureFields,
} from "./postgres-connection.mjs";

describe("managed PostgreSQL connection trust", () => {
  it("upgrades legacy remote TLS modes to verify-full", () => {
    const connectionString = normalizePostgresConnectionString(
      "postgresql://user:secret@db.example:25060/database?sslmode=require",
    );

    expect(connectionString).toContain("sslmode=verify-full");
    expect(connectionString).toContain("uselibpqcompat=true");
    expect(connectionString).not.toContain("sslmode=require");
  });

  it("threads the named CA into a verify-full Node pg client", () => {
    const reads = [];
    const config = postgresClientConfig(
      "postgresql://user:secret@db.example:25060/database?sslmode=verify-full&sslrootcert=%2Frunner%2Fca.pem",
      {},
      (path, encoding) => {
        reads.push({ path, encoding });
        return "test-ca-marker";
      },
    );

    expect(reads).toEqual([{ path: "/runner/ca.pem", encoding: "utf8" }]);
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: "test-ca-marker" });
  });

  it("keeps verification enabled when the CA is withheld", () => {
    expect(resolvePostgresSsl("postgresql://user:secret@db.example:25060/database?sslmode=verify-full", {})).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("does not treat PGSSLROOTCERT alone as trust for an sslmode-bearing URL", () => {
    const reads = [];
    const ssl = resolvePostgresSsl(
      "postgresql://user:secret@db.example:25060/database?sslmode=verify-full",
      { PGSSLROOTCERT: "/runner/env-only-ca.pem" },
      (...args) => reads.push(args),
    );

    expect(ssl).toEqual({ rejectUnauthorized: true });
    expect(reads).toEqual([]);
  });

  it("maps the withheld-CA failure to the named bounded certificate class", () => {
    const error = Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });

    expect(postgresFailureFields(error)).toEqual({
      classification: "self-signed-certificate-in-certificate-chain",
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
  });

  it("maps a PostgreSQL insufficient-privilege denial to a bounded classification and code without its message", () => {
    const error = Object.assign(new Error('permission denied for parameter "shared_preload_libraries"'), {
      code: "42501",
    });

    const fields = postgresFailureFields(error);

    expect(fields).toEqual({ classification: "postgres-query-failed", code: "42501" });
    expect(JSON.stringify(fields)).not.toContain("permission denied");
    expect(JSON.stringify(fields)).not.toContain("shared_preload_libraries");
  });

  it("never copies adversarial messages or secret-like status fields into structured logs", () => {
    const error = Object.assign(
      new Error("postgresql://user:secret@db.example/database -----BEGIN CERTIFICATE----- ca-marker"),
      { code: "TOKEN_secret-value", status: "bearer-secret" },
    );

    const serialized = JSON.stringify(safeFailureFields("managed-postgres-connect-failed", error));

    expect(serialized).toBe('{"classification":"managed-postgres-connect-failed"}');
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("CERTIFICATE");
    expect(serialized).not.toContain("ca-marker");
    expect(safeFailureFields("secret-bearing classification", error)).toEqual({
      classification: "unclassified-failure",
    });
  });
});
