import { describe, expect, it } from "vitest";
import { isPgConnectionLevelError, isPgRetryableTransientError } from "./types";

describe("postgres error classification", () => {
  it("classifies retryable Postgres and connection-level failures as transient", () => {
    expect(isPgRetryableTransientError({ code: "40001" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "40P01" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "55P03" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "57014" })).toBe(true);
    expect(isPgRetryableTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isPgRetryableTransientError(new Error("connection terminated unexpectedly"))).toBe(true);
  });

  it("keeps deterministic constraint errors off the transient path", () => {
    expect(isPgRetryableTransientError({ code: "23505" })).toBe(false);
    expect(isPgConnectionLevelError({ code: "23505" })).toBe(false);
  });
});
