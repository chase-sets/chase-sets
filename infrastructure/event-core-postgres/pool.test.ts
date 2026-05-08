import { describe, expect, it } from "vitest";
import { resolvePgPoolSslConfig } from "./pool";

describe("resolvePgPoolSslConfig", () => {
  it("uses libpq-compatible TLS behavior for sslmode=require", () => {
    expect(
      resolvePgPoolSslConfig(
        "postgresql://user:pass@example.com:25060/defaultdb?sslmode=require",
      ),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("leaves non-TLS local connection strings untouched", () => {
    expect(
      resolvePgPoolSslConfig("postgresql://postgres:postgres@localhost:5432/chase_sets"),
    ).toBeUndefined();
  });

  it("ignores malformed connection strings so pg can report the connection error", () => {
    expect(resolvePgPoolSslConfig("not a url")).toBeUndefined();
  });
});
