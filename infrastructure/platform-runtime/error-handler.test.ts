import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "./error-handler";

class TestDomainError extends Error {
  override name = "TestDomainError";
}

const testContext = {
  json: (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
} as Context;

describe("error handler", () => {
  it("maps domain errors to validation failures", async () => {
    const response = errorHandler(new TestDomainError("Invalid field."), testContext);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "validation_failed",
        message: "Invalid field.",
      },
    });
  });

  it("maps event-store concurrency conflicts to conflict responses", async () => {
    const response = errorHandler(
      {
        code: "concurrency_conflict",
        message: "Expected version mismatch.",
      },
      testContext,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "conflict",
        message: "Expected version mismatch.",
      },
    });
  });

  it("fails connection-exhausted event-store requests without exposing the database error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connectionError = {
      code: "infrastructure_failure",
      message: "Failed to append events to Postgres event store.",
      metadata: {
        cause: "remaining connection slots are reserved for roles with the SUPERUSER attribute",
        postgresCode: "53300",
      },
    };

    try {
      const response = errorHandler(connectionError, testContext);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toMatchObject({
        error: {
          code: "internal_error",
        },
      });
      expect(JSON.stringify(body)).not.toContain("connection slots");
      expect(consoleError).toHaveBeenCalledWith("Event store error:", connectionError);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("redacts unexpected errors behind an internal error response", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = errorHandler(new Error("provider secret"), testContext);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "internal_error",
        },
      });
      expect(consoleError).toHaveBeenCalledWith("Unhandled error:", expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });
});
