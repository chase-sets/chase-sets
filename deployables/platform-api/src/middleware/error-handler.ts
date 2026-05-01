import type { Context } from "hono";
import {
  conflictResponse,
  internalErrorResponse,
  validationFailedResponse,
} from "@chase-sets/http/responses";

type EventStoreErrorLike = Readonly<{
  code: string;
  message: string;
}>;

function isDomainError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    typeof error.name === "string" &&
    error.name.endsWith("DomainError")
  );
}

function isEventStoreError(error: unknown): error is EventStoreErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as EventStoreErrorLike).code === "string"
  );
}

export function errorHandler(error: unknown, c: Context): Response {
  if (isDomainError(error)) {
    return c.json(validationFailedResponse(error.message), 400);
  }

  if (isEventStoreError(error)) {
    if (error.code === "concurrency_conflict") {
      return c.json(conflictResponse(error.message), 409);
    }

    console.error("Event store error:", error);
    return c.json(internalErrorResponse(), 500);
  }

  console.error("Unhandled error:", error);
  return c.json(internalErrorResponse(), 500);
}
