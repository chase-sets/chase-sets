import { describe, expect, it } from "vitest";
import { createPgPool, normalizePgPoolConnectionString, resolvePgPoolSslConfig } from "./pool";

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

describe("createPgPool", () => {
  it("absorbs idle client errors by default", async () => {
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets") as unknown as {
      emit: (event: string, error: unknown) => boolean;
      end: () => Promise<void>;
    };

    expect(() => pool.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    await pool.end();
  });

  it("notifies the idle client error hook without letting hook failures escape", async () => {
    const idleError = new Error("Connection terminated unexpectedly");
    const reported: unknown[] = [];
    const pool = createPgPool("postgresql://postgres:postgres@localhost:5432/chase_sets", {
      onIdleClientError: ({ error }) => {
        reported.push(error);
        throw new Error("observer failed");
      },
    }) as unknown as {
      emit: (event: string, error: unknown) => boolean;
      end: () => Promise<void>;
    };

    expect(() => pool.emit("error", idleError)).not.toThrow();
    expect(reported).toEqual([idleError]);
    await pool.end();
  });
});
