import { describe, expect, it } from "vitest";
import { normalizePgPoolConnectionString, resolvePgPoolSslConfig } from "./pool";

describe("resolvePgPoolSslConfig", () => {
  it("uses libpq-compatible TLS behavior for sslmode=require", () => {
    expect(resolvePgPoolSslConfig("postgresql://user:pass@example.com:25060/defaultdb?sslmode=require")).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("leaves non-TLS local connection strings untouched", () => {
    expect(resolvePgPoolSslConfig("postgresql://postgres:postgres@localhost:5432/chase_sets")).toBeUndefined();
  });

  it("ignores malformed connection strings so pg can report the connection error", () => {
    expect(resolvePgPoolSslConfig("not a url")).toBeUndefined();
  });
});

describe("normalizePgPoolConnectionString", () => {
  it("opts sslmode=require URLs into pg's libpq-compatible parsing", () => {
    const normalized = normalizePgPoolConnectionString(
      "postgresql://user:pass@example.com:25060/defaultdb?sslmode=require",
    );

    expect(new URL(normalized).searchParams.get("uselibpqcompat")).toBe("true");
  });

  it("preserves existing uselibpqcompat choices", () => {
    const connectionString = "postgresql://user:pass@example.com/defaultdb?sslmode=require&uselibpqcompat=false";

    expect(normalizePgPoolConnectionString(connectionString)).toBe(connectionString);
  });
});
